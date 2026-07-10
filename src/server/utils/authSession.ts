import type { Request } from 'express'
import { randomUUID } from 'crypto'
import { eq } from 'drizzle-orm'
import { Redis } from 'ioredis'
import { db } from '../config/db.js'
import { authSessions } from '../db/schema.js'
import { signJwt } from './jwt.js'
import { getLocationFromIp, normalizeIp } from '../services/ipGeolocationService.js'
import { logger } from '../config/logger.js'

export interface DeviceInfo {
  deviceId?: string | null
  deviceType?: string | null
  deviceName?: string | null
}

function extractDeviceInfo(req: Request): DeviceInfo {
  const body = (req.body || {}) as Record<string, unknown>
  return {
    deviceId: typeof body.deviceId === 'string' ? body.deviceId : null,
    deviceType: typeof body.deviceType === 'string' ? body.deviceType : null,
    deviceName: typeof body.deviceName === 'string' ? body.deviceName : null,
  }
}

/**
 * Signs a JWT with a fresh `jti` and records the matching auth_sessions row.
 * Used by every login/signup route (login, signup, google login,
 * google/complete-signup) so each issued token maps to exactly one session.
 *
 * The session row insert is awaited (it's a single fast local insert, no
 * external call) so a client that immediately calls GET /api/sessions right
 * after login is guaranteed to see it -- but IP geolocation (an external
 * HTTP call that can take several hundred ms, see ipGeolocationService.ts)
 * is resolved afterward in the background and patched in with an UPDATE, so
 * it can never add latency to login/signup, and a geolocation failure can
 * never fail login. Matches this route file's existing non-blocking
 * login-alert-email pattern (fire-and-forget, errors only logged).
 */
export async function issueTokenWithSession(
  req: Request,
  user: { id: string; email: string; username: string },
): Promise<string> {
  const jti = randomUUID()
  const accessToken = signJwt({ sub: user.id, email: user.email, username: user.username, jti })

  const { deviceId, deviceType, deviceName } = extractDeviceInfo(req)
  // Stored/looked-up in normalized (bare IPv4, no "::ffff:" wrapper) form --
  // see ipGeolocationService.ts's normalizeIp for why the wrapper shows up
  // at all and why it must be stripped before anything checks/uses this IP.
  const ipAddress = req.ip ? normalizeIp(req.ip) : null
  const userAgent = req.get('User-Agent') || null

  try {
    const [session] = await db.insert(authSessions).values({
      userId: user.id,
      jti,
      deviceId,
      deviceType,
      deviceName,
      ipAddress,
      userAgent,
    }).returning({ id: authSessions.id })

    if (session && ipAddress) {
      getLocationFromIp(ipAddress)
        .then((geo) => {
          if (!geo) return
          return db.update(authSessions)
            .set({ locationCity: geo.city || null, locationCountry: geo.country || null })
            .where(eq(authSessions.id, session.id))
        })
        .catch((error) => logger.debug({ error, sessionId: session.id }, '[auth-session] background geolocation enrichment failed'))
    }
  } catch (error) {
    // Never block login/signup on session-recording failure.
    logger.error({ error, userId: user.id }, 'Failed to record auth session')
  }

  return accessToken
}

const TOUCH_THROTTLE_MS = 5 * 60 * 1000 // don't write on every request -- once per session per 5min is plenty for a "last active" display
const lastTouchByJti = new Map<string, number>()

/**
 * Best-effort, throttled `last_active_at` bump for a session -- called from
 * requireAuth on every authenticated request, so it must never add latency:
 * fire-and-forget, and skipped entirely unless it's been more than
 * TOUCH_THROTTLE_MS since the last touch for this jti (in-memory, so it
 * resets on redeploy -- acceptable, worst case is one extra early write).
 */
export function touchSessionActivity(jti: string): void {
  const now = Date.now()
  const last = lastTouchByJti.get(jti)
  if (last && now - last < TOUCH_THROTTLE_MS) return
  lastTouchByJti.set(jti, now)

  db.update(authSessions)
    .set({ lastActiveAt: new Date().toISOString() })
    .where(eq(authSessions.jti, jti))
    .catch((error) => logger.debug({ error, jti }, '[auth-session] failed to touch last_active_at'))
}

// ===========================================================================
// Session revocation (logout / remote "terminate this session")
// ===========================================================================
//
// Dedicated lazyConnect client, same self-contained pattern as the other
// Redis clients added this session (blind-dating.service.ts's lockRedis,
// ipGeolocationService.ts's geoRedis) -- never opens a connection just from
// being imported.
//
// Tighter connectTimeout/retryStrategy than those other clients: this one
// runs isSessionRevoked() on EVERY authenticated request app-wide (not a
// periodic background job), so a real Redis outage must fail open FAST.
// With ioredis's defaults (10s connectTimeout, backoff up to 2s/attempt),
// measured worst case for a single EXISTS check during an outage was over
// 1000ms per request -- effectively a soft app-wide outage of its own even
// though it does eventually let requests through. Capped here to keep the
// worst case in the low hundreds of ms.
const revocationRedis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 2,
  connectTimeout: 150,
  retryStrategy: (times) => Math.min(times * 30, 100),
  lazyConnect: true,
})
// Hit on every authenticated HTTP request -- previously had no error
// listener, so a Redis blip here was invisible.
revocationRedis.on('error', (err) => {
  logger.error({ err }, 'Auth revocation Redis client error')
})

// A revoked jti only ever needs to be remembered for as long as the token
// itself could still verify -- past its max lifetime it's rejected on
// expiry anyway, so there's no need to remember it forever. Must be >= the
// max lifetime signJwt ever issues (7d, see jwt.ts's DEFAULT_TOKEN_LIFETIME_MS).
const MAX_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60

function revokedKey(jti: string): string {
  return `revoked:jti:${jti}`
}

/**
 * Whether revocation enforcement is active. Read fresh from process.env on
 * every call (not cached) so it functions as a real kill switch -- flip it
 * off and the very next request stops being checked, no redeploy needed
 * (just a pod restart to pick up the new env value).
 *
 * Deliberately off by default: this must be turned on explicitly once the
 * rollout has been observed running clean, not silently on the moment this
 * code ships.
 */
export function isSessionRevocationEnforced(): boolean {
  return process.env.ENFORCE_SESSION_REVOCATION === 'true'
}

/**
 * Revokes a session: blacklists its jti in Redis (the actual enforcement
 * mechanism middleware/auth.ts checks on every request) and marks the
 * auth_sessions row revoked (for the Sessions list / bookkeeping). Each half
 * is independently best-effort and logged on failure rather than thrown --
 * a logout/terminate action should never itself 500 -- but a Redis failure
 * here is logged loudly since it means enforcement for this session may be
 * delayed.
 */
export async function revokeSession(jti: string, reason: string): Promise<void> {
  try {
    await revocationRedis.set(revokedKey(jti), '1', 'EX', MAX_TOKEN_LIFETIME_SECONDS)
  } catch (error) {
    logger.error({ error, jti }, '[auth-session] Failed to write session revocation to Redis -- this session may keep working until it next fails to renew')
  }

  try {
    await db.update(authSessions)
      .set({ revokedAt: new Date().toISOString(), revokedReason: reason })
      .where(eq(authSessions.jti, jti))
  } catch (error) {
    logger.error({ error, jti }, '[auth-session] Failed to mark auth_sessions row as revoked')
  }
}

/**
 * Checks whether a jti has been revoked. Fails OPEN on Redis errors (logs a
 * warning, returns false / "not revoked") -- matches this codebase's
 * established convention for Redis-backed checks (blind-dating's matching
 * lock, the engagement-notification schedulers' locks): a missing Redis
 * connection degrading this one security check is judged far less harmful
 * than a Redis blip 401-ing every authenticated request app-wide, since
 * this check runs in requireAuth on literally every request.
 */
export async function isSessionRevoked(jti: string): Promise<boolean> {
  try {
    const exists = await revocationRedis.exists(revokedKey(jti))
    return exists === 1
  } catch (error) {
    logger.warn({ error, jti }, '[auth-session] Revocation check failed (Redis unreachable?) -- failing open')
    return false
  }
}
