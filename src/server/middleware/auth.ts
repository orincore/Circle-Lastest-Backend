import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { verifyJwt, signJwt, shouldRenewToken } from '../utils/jwt.js'
import { touchSessionActivity, isSessionRevoked, isSessionRevocationEnforced } from '../utils/authSession.js'
import { logger } from '../config/logger.js'
import { eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { adminRoles } from '../db/schema.js'

export interface AuthRequest extends Request {
  user?: { id: string; email: string; username: string; role?: string }
  token?: string
  // Session id from the verified JWT's `jti` claim -- undefined for tokens
  // issued before Phase 3 (no jti yet), which is expected during rollout.
  jti?: string
  adminRole?: { id: string; role: string; is_active: boolean }
}

// Track failed authentication attempts for rate limiting
const failedAttempts = new Map<string, { count: number; resetTime: number }>()

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  
  // Gates a REJECTION, not the request itself — a device presenting a
  // currently-valid token must never be collateral-blocked by a past burst
  // of failures from itself (e.g. many screens firing in parallel right as
  // its old token expired). Only invoked right before a 401/format error
  // would otherwise be returned, so brute-forcing with bad tokens still
  // gets locked out, but a good token always gets through.
  const isRateLimited = () => {
    const attempts = failedAttempts.get(ip)
    return !!attempts && attempts.count >= 20 && Date.now() < attempts.resetTime
  }

  try {
    //console.log('🔐 Auth middleware - Path:', req.path, 'Method:', req.method)

    const header = req.headers.authorization || ''
    //console.log('🔐 Auth header present:', !!header, 'Starts with Bearer:', header.startsWith('Bearer '))

    // Validate authorization header format.
    // A missing/empty credential is NOT a brute-force signal — it's just an
    // unauthenticated request (e.g. logged-out client, or a screen that fired
    // before the token hydrated). Do NOT record a failed attempt for these,
    // otherwise a not-logged-in client bans its own IP within a few requests.
    if (!header.startsWith('Bearer ')) {
      //console.log('❌ Auth failed: Invalid header format')
      return res.status(StatusCodes.UNAUTHORIZED).json({
        error: 'Invalid authorization header format. Expected: Bearer <token>'
      })
    }

    const token = header.slice(7).trim()

    // Validate token is not empty or a stringified placeholder. Clients that
    // build the header as `Bearer ${token}` with an undefined/null token send
    // "Bearer undefined"/"Bearer null"; treat those as missing credentials
    // (no brute-force penalty) rather than as forged tokens.
    if (!token || token.length === 0 || token === 'undefined' || token === 'null') {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Missing Bearer token' })
    }

    // Validate token length (JWT tokens are typically 100-500 characters)
    if (token.length > 1000) {
      if (isRateLimited()) {
        logger.warn(`Too many failed auth attempts from IP: ${ip}`)
        return res.status(StatusCodes.TOO_MANY_REQUESTS).json({ error: 'Too many failed authentication attempts. Please try again later.' })
      }
      recordFailedAttempt(ip)
      logger.warn(`Suspiciously long token from IP: ${ip}`)
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token format' })
    }

    const payload = verifyJwt<{ sub: string; email: string; username: string; jti?: string }>(token)
    //console.log('🔐 JWT payload:', payload ? 'Valid' : 'Invalid', payload?.sub ? `User: ${payload.sub}` : '')

    if (!payload || !payload.sub || typeof payload.sub !== 'string' || payload.sub.length === 0) {
      //console.log('❌ Auth failed: Invalid token or missing sub')
      if (isRateLimited()) {
        logger.warn(`Too many failed auth attempts from IP: ${ip}`)
        return res.status(StatusCodes.TOO_MANY_REQUESTS).json({ error: 'Too many failed authentication attempts. Please try again later.' })
      }
      recordFailedAttempt(ip)
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token' })
    }

    // Clear failed attempts on successful auth
    failedAttempts.delete(ip)

    // Session revocation -- gated entirely behind ENFORCE_SESSION_REVOCATION
    // so this can ship dark and be turned on deliberately once observed
    // running clean, and flipped back off instantly (no redeploy, just a pod
    // restart to pick up the new env value) if it ever misbehaves.
    //
    // Not a brute-force signal either way (the token's signature is
    // genuinely valid), so neither branch below touches failedAttempts.
    if (isSessionRevocationEnforced()) {
      if (!payload.jti) {
        // Pre-rollout tokens have no session id to check/revoke by -- the
        // user's own explicit choice was "force everyone to log in again"
        // rather than silently grandfather these in, so this is deliberate.
        return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Session expired. Please log in again.' })
      }
      if (await isSessionRevoked(payload.jti)) {
        return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'You have been logged out. Please log in again.' })
      }
    }

    req.user = {
      id: payload.sub,
      email: payload.email || '',
      username: payload.username || ''
    }
    req.token = token
    req.jti = payload.jti

    if (payload.jti) {
      // Fire-and-forget, throttled internally -- never adds latency to the request.
      touchSessionActivity(payload.jti)
    }

    if (shouldRenewToken(token)) {
      // Renewal MUST keep the same jti -- minting a new one here would
      // silently orphan the auth_sessions row on every renewal (every ~3.5
      // days for an active user) and break "list/terminate my sessions"
      // later, since the session row's jti would no longer match the
      // token the client is actually using.
      const renewed = signJwt({ sub: payload.sub, email: payload.email || '', username: payload.username || '', jti: payload.jti })
      res.setHeader('X-Renewed-Token', renewed)
    }

    //console.log('✅ Auth successful - User ID:', payload.sub)
    return next()
  } catch (e) {
    recordFailedAttempt(ip)
    logger.error({ ip, error: e }, 'Authentication error')
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' })
  }
}

function recordFailedAttempt(ip: string) {
  const now = Date.now()
  const attempts = failedAttempts.get(ip)
  
  if (!attempts || now > attempts.resetTime) {
    failedAttempts.set(ip, { count: 1, resetTime: now + 900000 }) // 15 minutes
  } else {
    attempts.count++
  }
}

// Clean up old failed attempts periodically
setInterval(() => {
  const now = Date.now()
  for (const [ip, attempts] of failedAttempts.entries()) {
    if (now > attempts.resetTime) {
      failedAttempts.delete(ip)
    }
  }
}, 300000) // Clean up every 5 minutes

// Admin authorization middleware
export async function requireAdmin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.id) {
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Authentication required' })
    }

    // Check if user has admin role
    const rows = await db.select({ role: adminRoles.role }).from(adminRoles).where(eq(adminRoles.userId, req.user.id)).limit(1)
    const adminRole = rows[0]

    if (!adminRole) {
      logger.warn(`Unauthorized admin access attempt by user: ${req.user.id}`)
      return res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access required' })
    }

    // Attach admin role to request
    req.user = { ...req.user, role: adminRole.role }

    //console.log('✅ Admin auth successful - User ID:', req.user.id, 'Role:', adminRole.role)
    return next()
  } catch (e) {
    logger.error({ userId: req.user?.id, error: e }, 'Admin authorization error')
    return res.status(StatusCodes.FORBIDDEN).json({ error: 'Admin access denied' })
  }
}

