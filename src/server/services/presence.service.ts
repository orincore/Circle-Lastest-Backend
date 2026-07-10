import { Redis } from 'ioredis'
import { logger } from '../config/logger.js'

/**
 * Cluster-wide presence tracking (Redis-backed).
 *
 * `io.sockets.sockets.get(socketId)` and `io.sockets.adapter.rooms` only
 * resolve sockets/membership local to the CURRENT pod's in-memory Socket.IO
 * instance -- the room/adapter data itself is mirrored cluster-wide via the
 * Redis adapter, but walking a room's socket IDs and then doing a *local*
 * `.get()` on each one silently returns `undefined` for every socket living
 * on another pod. That used to mean: a user's chat partner shows them
 * "offline" whenever their live socket happens to be on a different pod
 * than the one handling the check; the "recipient already has this chat
 * open" push-notification gate and the server-authoritative delivery-
 * receipt gate silently fail the same way; and Jam Session's "both
 * listeners present" gate incorrectly refuses to start playback whenever
 * the two participants land on different pods -- all of which get worse
 * the more pods there are, i.e. exactly the direction production scaling
 * pushes.
 *
 * Shared by optimized-socket.ts (chat/user online presence) and
 * jamHandler.ts (jam-session presence) so both read/write the same source
 * of truth instead of each keeping a separate, pod-local approximation.
 *
 * Deliberately NOT using io.fetchSockets() for any of this -- that's an RPC
 * to every other pod per call, reserved for the existing (rare) cross-pod
 * broadcast paths. These presence checks run on the hot per-message path
 * and need to stay O(1) local Redis calls.
 */

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})
redis.on('error', (err) => {
  logger.error({ err }, 'Presence Redis client error')
})

function userKey(userId: string): string {
  return `presence:user:${userId}`
}

function chatActiveUserKey(chatId: string, userId: string): string {
  return `presence:chatactive:${chatId}:${userId}`
}

function chatActiveTotalKey(chatId: string): string {
  return `presence:chatactive:${chatId}:total`
}

function jamUserKey(sessionId: string, userId: string): string {
  return `presence:jam:${sessionId}:${userId}`
}

/** Adds this socket to the user's presence set. Returns the resulting cluster-wide connection count. */
export async function markUserOnline(userId: string, socketId: string): Promise<number> {
  try {
    await redis.sadd(userKey(userId), socketId)
    return await redis.scard(userKey(userId))
  } catch (err) {
    logger.error({ err, userId }, 'Failed to mark user online in presence store')
    return -1 // sentinel: caller should treat as "unknown, don't broadcast"
  }
}

/** Removes this socket from the user's presence set. Returns the resulting cluster-wide connection count. */
export async function markUserOffline(userId: string, socketId: string): Promise<number> {
  try {
    await redis.srem(userKey(userId), socketId)
    return await redis.scard(userKey(userId))
  } catch (err) {
    logger.error({ err, userId }, 'Failed to mark user offline in presence store')
    return -1
  }
}

/** Is this user connected on ANY pod right now. */
export async function isUserOnline(userId: string): Promise<boolean> {
  try {
    return (await redis.scard(userKey(userId))) > 0
  } catch (err) {
    logger.error({ err, userId }, 'Failed to check user presence')
    return false
  }
}

/** Does this user have `chatId` foregrounded on ANY of their devices right now. */
export async function isUserActiveInChat(userId: string, chatId: string): Promise<boolean> {
  try {
    return (await redis.scard(chatActiveUserKey(chatId, userId))) > 0
  } catch (err) {
    logger.error({ err, userId, chatId }, 'Failed to check chat-active presence')
    return false
  }
}

/**
 * Records this socket as viewing `chatId` and, only on the socket's first
 * entry for this chat (SADD returns 0 on a duplicate), bumps the chat-wide
 * "someone has it open" total. Returns the new total, or null if this call
 * was a no-op duplicate (caller should skip broadcasting).
 */
export async function markChatActive(chatId: string, userId: string, socketId: string): Promise<number | null> {
  try {
    const added = await redis.sadd(chatActiveUserKey(chatId, userId), socketId)
    if (!added) return null
    return await redis.incr(chatActiveTotalKey(chatId))
  } catch (err) {
    logger.error({ err, chatId, userId }, 'Failed to mark chat active in presence store')
    return null
  }
}

/**
 * Mirrors markChatActive for leaving. The floor-at-0 guard keeps a missed
 * disconnect from ever leaving the total permanently negative -- self-heals
 * on the next active/inactive event, same as the old per-pod counter did,
 * just now correct across pods instead of only within one.
 */
export async function markChatInactive(chatId: string, userId: string, socketId: string): Promise<number | null> {
  try {
    const removed = await redis.srem(chatActiveUserKey(chatId, userId), socketId)
    if (!removed) return null
    let total = await redis.decr(chatActiveTotalKey(chatId))
    if (total < 0) {
      await redis.set(chatActiveTotalKey(chatId), 0)
      total = 0
    }
    return total
  } catch (err) {
    logger.error({ err, chatId, userId }, 'Failed to mark chat inactive in presence store')
    return null
  }
}

/** Is this user present (foregrounded) in this jam session on ANY device. */
export async function isUserPresentInJam(sessionId: string, userId: string): Promise<boolean> {
  try {
    return (await redis.scard(jamUserKey(sessionId, userId))) > 0
  } catch (err) {
    logger.error({ err, sessionId, userId }, 'Failed to check jam presence')
    return false
  }
}

export async function markJamPresence(sessionId: string, userId: string, socketId: string, isPresent: boolean): Promise<void> {
  try {
    if (isPresent) {
      await redis.sadd(jamUserKey(sessionId, userId), socketId)
    } else {
      await redis.srem(jamUserKey(sessionId, userId), socketId)
    }
  } catch (err) {
    logger.error({ err, sessionId, userId, isPresent }, 'Failed to update jam presence store')
  }
}
