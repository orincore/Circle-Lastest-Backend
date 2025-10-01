import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { verifyJwt } from '../utils/jwt.js'
import { logger } from '../config/logger.js'

export interface AuthRequest extends Request {
  user?: { id: string; email: string; username: string }
  token?: string
}

// Track failed authentication attempts for rate limiting
const failedAttempts = new Map<string, { count: number; resetTime: number }>()

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown'
  
  try {
    // Check for rate limiting on failed attempts
    const attempts = failedAttempts.get(ip)
    if (attempts && attempts.count >= 10 && Date.now() < attempts.resetTime) {
      logger.warn(`Too many failed auth attempts from IP: ${ip}`)
      return res.status(StatusCodes.TOO_MANY_REQUESTS).json({ 
        error: 'Too many failed authentication attempts. Please try again later.' 
      })
    }

    const header = req.headers.authorization || ''
    
    // Validate authorization header format
    if (!header.startsWith('Bearer ')) {
      recordFailedAttempt(ip)
      return res.status(StatusCodes.UNAUTHORIZED).json({ 
        error: 'Invalid authorization header format. Expected: Bearer <token>' 
      })
    }

    const token = header.slice(7)
    
    // Validate token is not empty
    if (!token || token.length === 0) {
      recordFailedAttempt(ip)
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Missing Bearer token' })
    }

    // Validate token length (JWT tokens are typically 100-500 characters)
    if (token.length > 1000) {
      recordFailedAttempt(ip)
      logger.warn(`Suspiciously long token from IP: ${ip}`)
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token format' })
    }

    const payload = verifyJwt<{ sub: string; email: string; username: string }>(token)
    
    if (!payload || !payload.sub) {
      recordFailedAttempt(ip)
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token' })
    }

    // Validate payload structure
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      recordFailedAttempt(ip)
      return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token payload' })
    }

    // Clear failed attempts on successful auth
    failedAttempts.delete(ip)

    req.user = { 
      id: payload.sub, 
      email: payload.email || '', 
      username: payload.username || '' 
    }
    req.token = token
    
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
