import { Server as IOServer, Socket } from 'socket.io'
import { logger } from '../config/logger.js'
import { findRecommendation } from '../services/youtube.service.js'
import {
  addToQueue,
  computeLivePositionMs,
  getChatMemberIds,
  getExcludedVideoIds,
  getNextQueueItem,
  getPreviousQueueItem,
  getQueueForSession,
  getQueueItem,
  getSession,
  isChatMember,
  markQueueItemStatus,
  setCurrentTrack,
  setParticipantPresence,
  setPlaybackState,
  type JamSession,
} from '../repos/jam.repo.js'

/**
 * Socket handlers for jam sessions (listen-together playback).
 *
 * Reuses the existing `chat:{chatId}` room (joined via the `chat:join` handler
 * in optimized-socket.ts) rather than a separate jam room — a jam session is
 * always scoped to a single 1:1 chat.
 *
 * Presence gating mirrors the `chat:active`/`chat:inactive` -> `activeChats`
 * pattern in optimized-socket.ts (see isUserActiveInChat there), but is
 * reimplemented here against a parallel `activeJamSessions` set on
 * socket.data, since that helper is private to the other module's closure.
 * Unlike chat presence, jam presence is also cleaned up on disconnect (see
 * cleanupJamPresenceOnDisconnect) — a stuck "present" flag after an app kill
 * would mean playback never auto-pauses, which matters much more here than
 * for the chat-open indicator.
 */

function room(chatId: string) {
  return `chat:${chatId}`
}

function isUserPresentInJam(io: IOServer, userId: string, sessionId: string): boolean {
  const userRoom = io.sockets.adapter.rooms.get(userId)
  if (!userRoom) return false
  for (const socketId of userRoom) {
    const sock = io.sockets.sockets.get(socketId)
    const active = (sock?.data as any)?.activeJamSessions
    if (active instanceof Set && active.has(sessionId)) return true
  }
  return false
}

async function computeBothPresent(io: IOServer, session: JamSession): Promise<boolean> {
  const memberIds = await getChatMemberIds(session.chat_id)
  if (memberIds.length < 2) return false
  return memberIds.every((id) => isUserPresentInJam(io, id, session.id))
}

async function handlePresenceChange(
  io: IOServer,
  socket: Socket,
  userId: string,
  sessionId: string,
  isPresent: boolean,
  positionMs?: number
) {
  const data: any = socket.data || {}
  if (!data.activeJamSessions) data.activeJamSessions = new Set<string>()
  const wasPresent = data.activeJamSessions.has(sessionId)
  if (isPresent) data.activeJamSessions.add(sessionId)
  else data.activeJamSessions.delete(sessionId)
  socket.data = data

  setParticipantPresence(sessionId, userId, isPresent).catch((err) =>
    logger.error({ err, sessionId, userId }, 'Failed to persist jam presence')
  )

  // Presence is re-asserted periodically (heartbeat) and on every reconnect, not just on
  // genuine transitions — skip the broadcast/recompute below when nothing actually changed
  // for THIS socket, so a heartbeat doesn't spam the room every ~20s.
  if (wasPresent === isPresent) return

  const session = await getSession(sessionId)
  if (!session || session.status === 'ended') return
  const r = room(session.chat_id)
  io.to(r).emit('jam:presence', { sessionId, userId, isPresent })

  const bothPresent = await computeBothPresent(io, session)
  if (!bothPresent && session.is_playing) {
    const finalPositionMs = typeof positionMs === 'number' ? positionMs : computeLivePositionMs(session)
    await setPlaybackState(sessionId, { isPlaying: false, positionMs: finalPositionMs, pausedForPresence: true })
    io.to(r).emit('jam:playback:paused', { sessionId, reason: 'presence', positionMs: finalPositionMs })
  }
}

/** Advances past the current track: plays the next queued item, or fetches an auto-recommendation if the queue is empty. */
async function advanceToNext(io: IOServer, session: JamSession) {
  const r = room(session.chat_id)

  let afterPosition: number | null = null
  let finishedItem = null as Awaited<ReturnType<typeof getQueueItem>>
  if (session.current_queue_item_id) {
    finishedItem = await getQueueItem(session.current_queue_item_id)
    afterPosition = finishedItem?.position ?? null
    await markQueueItemStatus(session.current_queue_item_id, 'played')
  }

  let next = await getNextQueueItem(session.id, afterPosition)

  if (!next && finishedItem) {
    try {
      const excluded = await getExcludedVideoIds(session.id)
      const rec = await findRecommendation({ title: finishedItem.title, channelTitle: finishedItem.channel_title }, excluded)
      if (rec) {
        next = await addToQueue({
          sessionId: session.id,
          youtubeVideoId: rec.videoId,
          title: rec.title,
          channelTitle: rec.channelTitle,
          thumbnailUrl: rec.thumbnailUrl,
          durationSeconds: rec.durationSeconds,
          addedBy: session.started_by,
          isAutoRecommended: true,
        })
        io.to(r).emit('jam:queue:updated', { sessionId: session.id, queue: await getQueueForSession(session.id) })
      }
    } catch (err) {
      logger.error({ err, sessionId: session.id }, 'Failed to fetch jam auto-recommendation')
    }
  }

  if (next) {
    await markQueueItemStatus(next.id, 'playing')
    await setCurrentTrack(session.id, next.id)
    io.to(r).emit('jam:playback:track_changed', { sessionId: session.id, queueItem: next, positionMs: 0 })
  } else {
    await setCurrentTrack(session.id, null)
    await setPlaybackState(session.id, { isPlaying: false })
    io.to(r).emit('jam:playback:track_changed', { sessionId: session.id, queueItem: null, positionMs: 0 })
  }
}

export function setupJamHandlers(io: IOServer, socket: Socket, userId: string) {
  socket.on('jam:active', async ({ sessionId }: { sessionId: string }) => {
    if (!sessionId) return
    try {
      await handlePresenceChange(io, socket, userId, sessionId, true)
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:active failed')
    }
  })

  socket.on('jam:inactive', async ({ sessionId, positionMs }: { sessionId: string; positionMs?: number }) => {
    if (!sessionId) return
    try {
      await handlePresenceChange(io, socket, userId, sessionId, false, positionMs)
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:inactive failed')
    }
  })

  socket.on('jam:play', async ({ sessionId }: { sessionId: string }) => {
    try {
      const session = await getSession(sessionId)
      if (!session || session.status === 'ended') return
      if (!(await isChatMember(session.chat_id, userId))) return

      // Pressing play IS itself unambiguous proof this user is here — mark them present
      // synchronously before checking, rather than trusting whatever jam:active last
      // reported. jam:active only fires on mount/AppState-change/heartbeat/reconnect, so
      // there's always some window after those where the flag can be a few seconds stale;
      // without this, the very person pressing play could get rejected as "not present"
      // by their own request. (Also fixes it as a side effect for the other participant,
      // if this happens to be the first genuine change: handlePresenceChange broadcasts
      // jam:presence when the flag actually flips, correcting any stale display on their end.)
      await handlePresenceChange(io, socket, userId, sessionId, true)

      const bothPresent = await computeBothPresent(io, session)
      if (!bothPresent) {
        socket.emit('jam:error', { sessionId, code: 'not_both_present', message: 'Both listeners must be present to play' })
        return
      }

      // Broadcast immediately rather than waiting on a DB write + a second read-back — the
      // ~1s gap users noticed between "I hit play" and "it starts on the other device" was
      // largely this round trip, on top of unavoidable network latency. Nothing in this
      // event actually changes playback_position_ms, so the position we already have from
      // the read above is exactly what a re-read would return; the write below is
      // fire-and-forget, needed only so a later reconnect/resync sees the correct persisted
      // state, not for this broadcast's own correctness.
      io.to(room(session.chat_id)).emit('jam:playback:state', {
        sessionId,
        isPlaying: true,
        positionMs: session.playback_position_ms,
        currentQueueItemId: session.current_queue_item_id,
        serverTime: Date.now(),
      })
      setPlaybackState(sessionId, { isPlaying: true, pausedForPresence: false }).catch((err) =>
        logger.error({ err, sessionId, userId }, 'Failed to persist jam play state')
      )
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:play failed')
    }
  })

  socket.on('jam:pause', async ({ sessionId, positionMs }: { sessionId: string; positionMs?: number }) => {
    try {
      const session = await getSession(sessionId)
      if (!session || session.status === 'ended') return
      if (!(await isChatMember(session.chat_id, userId))) return

      const finalPositionMs = typeof positionMs === 'number' ? positionMs : session.playback_position_ms
      // Same fire-and-forget rationale as jam:play above — broadcast first, persist after.
      io.to(room(session.chat_id)).emit('jam:playback:paused', { sessionId, reason: 'user', positionMs: finalPositionMs })
      setPlaybackState(sessionId, { isPlaying: false, positionMs: finalPositionMs, pausedForPresence: false }).catch((err) =>
        logger.error({ err, sessionId, userId }, 'Failed to persist jam pause state')
      )
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:pause failed')
    }
  })

  socket.on('jam:seek', async ({ sessionId, positionMs }: { sessionId: string; positionMs: number }) => {
    try {
      const session = await getSession(sessionId)
      if (!session || session.status === 'ended') return
      if (!(await isChatMember(session.chat_id, userId))) return
      if (typeof positionMs !== 'number') return

      // Same fire-and-forget rationale as jam:play above — a seek doesn't change is_playing
      // or current_queue_item_id, so the pre-write `session` already has everything needed
      // for the broadcast; no need to write, then read it all back before telling clients.
      io.to(room(session.chat_id)).emit('jam:playback:state', {
        sessionId,
        isPlaying: session.is_playing,
        positionMs,
        currentQueueItemId: session.current_queue_item_id,
        serverTime: Date.now(),
      })
      setPlaybackState(sessionId, { positionMs }).catch((err) =>
        logger.error({ err, sessionId, userId }, 'Failed to persist jam seek state')
      )
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:seek failed')
    }
  })

  socket.on('jam:next', async ({ sessionId }: { sessionId: string }) => {
    try {
      const session = await getSession(sessionId)
      if (!session || session.status === 'ended') return
      if (!(await isChatMember(session.chat_id, userId))) return
      await advanceToNext(io, session)
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:next failed')
    }
  })

  socket.on('jam:previous', async ({ sessionId }: { sessionId: string }) => {
    try {
      const session = await getSession(sessionId)
      if (!session || session.status === 'ended') return
      if (!(await isChatMember(session.chat_id, userId))) return

      const r = room(session.chat_id)
      const currentItem = session.current_queue_item_id ? await getQueueItem(session.current_queue_item_id) : null
      if (!currentItem) return

      const prev = await getPreviousQueueItem(session.id, currentItem.position)
      if (!prev) return

      await markQueueItemStatus(currentItem.id, 'queued')
      await markQueueItemStatus(prev.id, 'playing')
      await setCurrentTrack(session.id, prev.id)
      io.to(r).emit('jam:playback:track_changed', { sessionId: session.id, queueItem: prev, positionMs: 0 })
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:previous failed')
    }
  })

  // Fired by whichever client's embedded player reaches the END state first. Debounced by
  // checking the session's current track still matches — a second report after the session
  // has already advanced is a stale/duplicate signal and is ignored.
  socket.on('jam:track:ended', async ({ sessionId, queueItemId }: { sessionId: string; queueItemId: string }) => {
    try {
      const session = await getSession(sessionId)
      if (!session || session.status === 'ended') return
      if (!(await isChatMember(session.chat_id, userId))) return
      if (session.current_queue_item_id !== queueItemId) return
      await advanceToNext(io, session)
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:track:ended failed')
    }
  })

  // Client-pulled drift correction (rather than a server-pushed interval per session, which
  // would need cross-instance leader election to avoid duplicate broadcasts under the Redis
  // adapter) — the client asks periodically while playing and reconciles locally. Must use
  // computeLivePositionMs here, not the raw column — the server never ticks position forward
  // on its own, so the raw value is frozen at whatever it was when playback last started.
  socket.on('jam:sync:request', async ({ sessionId }: { sessionId: string }) => {
    try {
      const session = await getSession(sessionId)
      if (!session) return
      socket.emit('jam:playback:state', {
        sessionId,
        isPlaying: session.is_playing,
        positionMs: computeLivePositionMs(session),
        currentQueueItemId: session.current_queue_item_id,
        serverTime: Date.now(),
      })
    } catch (err) {
      logger.error({ err, sessionId, userId }, 'jam:sync:request failed')
    }
  })
}

/** Called from the main socket disconnect handler so an app kill / network drop doesn't leave a session stuck "present" forever. */
export function cleanupJamPresenceOnDisconnect(io: IOServer, socket: Socket, userId: string) {
  const active: Set<string> | undefined = (socket.data as any)?.activeJamSessions
  if (!active || !active.size) return
  for (const sessionId of Array.from(active)) {
    handlePresenceChange(io, socket, userId, sessionId, false).catch((err) =>
      logger.error({ err, sessionId, userId }, 'Failed to clean up jam presence on disconnect')
    )
  }
}
