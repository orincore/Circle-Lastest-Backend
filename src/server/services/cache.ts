import { Redis } from 'ioredis'
import { logger } from '../config/logger.js'

/**
 * General-purpose cache with Redis backing and a graceful in-memory fallback.
 *
 * - In production (or wherever REDIS_HOST is reachable) this uses Redis, so the
 *   cache is shared across all backend instances.
 * - If Redis is unavailable (e.g. local dev without docker redis running) it
 *   transparently falls back to an in-process Map so the app still works and
 *   stays fast — it just isn't shared across instances.
 *
 * All methods are best-effort: a cache failure never throws to the caller, it
 * simply behaves as a cache miss so the underlying data source is used.
 */

const REDIS_ENABLED = process.env.CACHE_REDIS_DISABLED !== 'true'

let redis: Redis | null = null
let redisHealthy = false

if (REDIS_ENABLED) {
  redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: 2,
    // Don't spam reconnects when redis isn't running locally.
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
    lazyConnect: true,
    enableOfflineQueue: false,
  })

  redis.on('ready', () => {
    redisHealthy = true
    logger.info('🗄️  Cache: Redis connected')
  })
  redis.on('end', () => {
    redisHealthy = false
  })
  redis.on('error', (err) => {
    if (redisHealthy) logger.warn({ error: err?.message }, 'Cache: Redis error, falling back to memory')
    redisHealthy = false
  })

  // Kick off the connection but never let a failure crash startup.
  redis.connect().catch(() => {
    redisHealthy = false
    logger.warn('🗄️  Cache: Redis unavailable, using in-memory fallback')
  })
}

// ---- In-memory fallback ----
interface MemEntry { value: string; expiresAt: number }
const memStore = new Map<string, MemEntry>()

function memSet(key: string, value: string, ttlSeconds: number) {
  memStore.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
}
function memGet(key: string): string | null {
  const e = memStore.get(key)
  if (!e) return null
  if (Date.now() > e.expiresAt) {
    memStore.delete(key)
    return null
  }
  return e.value
}
function memDel(keys: string[]) {
  for (const k of keys) memStore.delete(k)
}
function memDelByPrefix(prefix: string) {
  for (const k of memStore.keys()) {
    if (k.startsWith(prefix)) memStore.delete(k)
  }
}

// Periodically sweep expired in-memory entries.
setInterval(() => {
  const now = Date.now()
  for (const [k, e] of memStore.entries()) {
    if (now > e.expiresAt) memStore.delete(k)
  }
}, 60_000).unref?.()

const useRedis = () => !!redis && redisHealthy

export const cache = {
  async getJSON<T>(key: string): Promise<T | null> {
    try {
      const raw = useRedis() ? await redis!.get(key) : memGet(key)
      return raw ? (JSON.parse(raw) as T) : null
    } catch (err) {
      logger.debug?.({ err, key }, 'cache.getJSON failed')
      return null
    }
  },

  async setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    try {
      const raw = JSON.stringify(value)
      if (useRedis()) {
        await redis!.setex(key, ttlSeconds, raw)
      } else {
        memSet(key, raw, ttlSeconds)
      }
    } catch (err) {
      logger.debug?.({ err, key }, 'cache.setJSON failed')
    }
  },

  /**
   * Atomically increment a counter (creating it at 1 if absent). Used as a
   * cache "generation" stamp: bumping it retires every cache entry keyed to
   * the old generation without needing to delete them individually, and
   * without the delete-then-repopulate race a plain `del` has (a concurrent
   * read that started before the bump can still finish after it and write a
   * stale value back — bumping the generation makes that write land on an
   * abandoned key instead of clobbering the fresh one).
   */
  async incr(key: string): Promise<number> {
    try {
      if (useRedis()) return await redis!.incr(key)
      const current = parseInt(memGet(key) || '0', 10) || 0
      const next = current + 1
      memSet(key, String(next), 60 * 60 * 24)
      return next
    } catch (err) {
      logger.debug?.({ err, key }, 'cache.incr failed')
      // Fall back to a value that's always different from any prior
      // generation so the caller still gets an effective cache-bust.
      return Date.now()
    }
  },

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return
    try {
      if (useRedis()) await redis!.del(...keys)
      // Always clear memory too in case we recently fell back.
      memDel(keys)
    } catch (err) {
      logger.debug?.({ err, keys }, 'cache.del failed')
      memDel(keys)
    }
  },

  /** Delete every key starting with `prefix`. Uses SCAN on Redis to stay non-blocking. */
  async delByPrefix(prefix: string): Promise<void> {
    try {
      if (useRedis()) {
        let cursor = '0'
        do {
          const [next, found] = await redis!.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200)
          cursor = next
          if (found.length) await redis!.del(...found)
        } while (cursor !== '0')
      }
      memDelByPrefix(prefix)
    } catch (err) {
      logger.debug?.({ err, prefix }, 'cache.delByPrefix failed')
      memDelByPrefix(prefix)
    }
  },
}

// ---- Key builders (centralized so invalidation stays consistent) ----
export const cacheKeys = {
  // Generation-stamped so invalidation can bump the generation (see
  // `cache.incr`) instead of deleting the key outright -- see invalidateChatCaches.
  inbox: (userId: string, generation: number | string = 0) => `chat:inbox:${userId}:${generation}`,
  inboxVersion: (userId: string) => `chat:inbox:ver:${userId}`,
  // History keys share the `chat:hist:{chatId}:` prefix so all of a chat's
  // per-user history pages can be invalidated together.
  historyPrefix: (chatId: string) => `chat:hist:${chatId}:`,
  history: (chatId: string, userId: string, limit: number) => `chat:hist:${chatId}:${userId}:${limit}`,

  // Profile page caches. Three independent representations of a user's profile:
  //  - self:   the signed-in user's own profile (GraphQL `me`)
  //  - view:   another user's profile + stats (GET /api/explore/user/:userId)
  //  - public: the public-by-username profile (GET /api/public/profile/:username)
  profileSelf: (userId: string) => `profile:self:${userId}`,
  profileView: (userId: string) => `profile:view:${userId}`,
  profilePublic: (username: string) => `profile:public:${String(username).trim().toLowerCase()}`,

  // Notification caches. All of a user's notification keys share the
  // `notif:{userId}:` prefix (list pages keyed by limit + the unread count) so a
  // single delByPrefix invalidates everything when their notifications change.
  notificationsPrefix: (userId: string) => `notif:${userId}:`,
  notificationList: (userId: string, limit: number) => `notif:${userId}:list:${limit}`,
  notificationUnread: (userId: string) => `notif:${userId}:unread`,

  // Meme feed caches. `memeContent` holds the immutable parts of a meme
  // (caption/assets/post_type) shared across every viewer -- live per-viewer
  // fields (like_count, liked_by_me) are never cached here. Comments are keyed
  // per meme+page under a shared `memeCommentsPrefix` so a new comment can
  // invalidate every cached page of that meme in one call. `memeAlias` caches
  // the (immutable once created) anonymous alias lookup used on every comment row.
  // Versioned (`v2`) because the cached shape changed (added `poster_alias`,
  // then changed its format) -- bump this suffix again if MemeContent's shape
  // changes, so stale cached payloads from an older shape don't linger for a
  // full TTL and silently omit new fields on the client.
  memeContent: (memeId: string) => `meme:content:v2:${memeId}`,
  memeCommentsPrefix: (memeId: string) => `meme:comments:${memeId}:`,
  memeComments: (memeId: string, limit: number, offset: number) => `meme:comments:${memeId}:${limit}:${offset}`,
  memeAlias: (userId: string) => `meme:alias:${userId}`,
  // Server-side-blurred derivative of a user's real profile photo, used for
  // anonymous comment avatars -- the raw photo never reaches the client, only
  // this already-blurred version, so it can't be "un-blurred" from the
  // network response the way a client-side blur overlay could be.
  anonAvatar: (userId: string) => `meme:anon-avatar:${userId}`,
}

// `memeContent` TTL is a safety net against a missed invalidation (moderation
// action) -- explicit `cache.del` on moderation keeps it fresh in practice.
export const MEME_CONTENT_TTL = 3600
// Comments change often but not on every request; explicit invalidation on
// new-comment handles the real-time case, TTL is just a backstop.
export const MEME_COMMENTS_TTL = 120
// Aliases never change once created.
export const MEME_ALIAS_TTL = 86400
// Profile photos rarely change; explicit invalidation (see
// invalidateProfileCache) keeps this fresh in practice, TTL is a backstop.
export const ANON_AVATAR_TTL = 21600

// Notifications change frequently and are explicitly invalidated on every write,
// so the TTL is just a safety net against a missed invalidation.
export const NOTIFICATIONS_TTL = 120

/**
 * Invalidate every cached notification representation for a user (all list
 * pages + the unread count). Call this whenever a notification is created,
 * read, deleted, or marked all-read for the user.
 */
export async function invalidateNotificationsCache(userId: string): Promise<void> {
  if (!userId) return
  await cache.delByPrefix(cacheKeys.notificationsPrefix(userId))
}

// TTLs (seconds) for the profile caches. The `view` payload includes volatile
// stats (message counts) so it expires quickly; explicit invalidation handles
// the things users notice immediately (profile edits, friend changes).
export const PROFILE_TTL = {
  self: 300,
  view: 60,
  public: 300,
}

/**
 * Invalidate every cached representation of a user's profile. Call this whenever
 * the user's profile details, friend count, or photos change so the profile page
 * (their own and how others see them) reloads fresh.
 *
 * Pass `username` when it is known (e.g. on a profile-details update) so the
 * public-by-username cache is cleared too; friend-count changes don't need it
 * (the public endpoint doesn't expose friend counts).
 */
export async function invalidateProfileCache(userId: string, username?: string | null): Promise<void> {
  const keys = [cacheKeys.profileSelf(userId), cacheKeys.profileView(userId), cacheKeys.anonAvatar(userId)]
  if (username) keys.push(cacheKeys.profilePublic(username))
  await cache.del(...keys)
}
