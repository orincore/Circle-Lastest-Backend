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
  inbox: (userId: string) => `chat:inbox:${userId}`,
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
}

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
  const keys = [cacheKeys.profileSelf(userId), cacheKeys.profileView(userId)]
  if (username) keys.push(cacheKeys.profilePublic(username))
  await cache.del(...keys)
}
