import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'

export interface JwtPayload {
  sub: string
  email: string
  username: string
  // Session id, tying this specific issued token to an auth_sessions row.
  // Optional so tokens issued before this field existed keep verifying
  // fine -- see middleware/auth.ts for how the two cases are told apart.
  jti?: string
}

export function signJwt(payload: JwtPayload, expiresIn: string = '7d'): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn } as jwt.SignOptions)
}

export function verifyJwt<T = JwtPayload>(token: string): T | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as T
    //console.log('🔓 JWT decoded successfully:', decoded)
    return decoded
  } catch (error) {
    console.error('❌ JWT verification failed:', error instanceof Error ? error.message : error)
    return null
  }
}

const DEFAULT_TOKEN_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000
const RENEWAL_THRESHOLD_MS = DEFAULT_TOKEN_LIFETIME_MS / 2

// Access tokens have no refresh-token counterpart — a session only stays alive
// by the client picking up a reissued token before the old one dies. Sliding
// renewal: once a verified token is past the midpoint of its life, mint a
// fresh 7d token so an active user's session never hits a hard expiry wall.
export function shouldRenewToken(token: string): boolean {
  const decoded = jwt.decode(token) as { exp?: number } | null
  if (!decoded?.exp) return false
  const remainingMs = decoded.exp * 1000 - Date.now()
  return remainingMs > 0 && remainingMs < RENEWAL_THRESHOLD_MS
}
