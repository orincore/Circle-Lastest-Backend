import type { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { verifyJwt } from '../utils/jwt.js'

export interface AuthRequest extends Request {
  user?: { id: string; email: string; username: string }
  token?: string
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : undefined
    if (!token) return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Missing Bearer token' })

    const payload = verifyJwt<{ sub: string; email: string; username: string }>(token)
    if (!payload) return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Invalid token' })

    req.user = { id: payload.sub, email: payload.email, username: payload.username }
    req.token = token
    return next()
  } catch (e) {
    return res.status(StatusCodes.UNAUTHORIZED).json({ error: 'Unauthorized' })
  }
}
