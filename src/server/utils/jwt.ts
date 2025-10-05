import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export interface JwtPayload {
  sub: string
  email: string
  username: string
}

export function signJwt(payload: JwtPayload, expiresIn: string = '7d'): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn } as jwt.SignOptions)
}

export function verifyJwt<T = JwtPayload>(token: string): T | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as T
    console.log('🔓 JWT decoded successfully:', decoded)
    return decoded
  } catch (error) {
    console.error('❌ JWT verification failed:', error instanceof Error ? error.message : error)
    return null
  }
}
