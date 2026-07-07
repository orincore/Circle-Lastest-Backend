import { eq } from 'drizzle-orm'
import sharp from 'sharp'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'
import { cache, cacheKeys, ANON_AVATAR_TTL } from './cache.js'
import { logger } from '../config/logger.js'

const AVATAR_SIZE = 64
const BLUR_SIGMA = 14

// Cached negative-result sentinel -- distinguishes "we checked, there's no
// usable photo" from "not cached yet" (cache.getJSON returns null for both a
// miss and a cached JSON `null`, so a plain null can't be reused as the
// sentinel without collapsing that distinction and defeating the cache).
const NO_AVATAR_SENTINEL = '__none__'

/**
 * Returns a heavily blurred, low-resolution data URI derived from a user's
 * real profile photo, for anonymous display contexts (meme comments). The
 * raw photo bytes are fetched and processed entirely server-side and never
 * sent to the client -- only this already-blurred derivative is. That's
 * deliberate: a client-side blur overlay is purely cosmetic (the original
 * image still crosses the network and sits in cache, inspectable by anyone
 * who looks), which would undermine the anonymity this feed's alias system
 * is built around (see memeConnect.service.ts).
 *
 * Returns null if the user has no profile photo, or if fetching/processing
 * it fails -- callers should fall back to a synthetic placeholder avatar.
 */
export async function getBlurredAvatarDataUri(userId: string): Promise<string | null> {
  const cacheKey = cacheKeys.anonAvatar(userId)
  const cached = await cache.getJSON<string>(cacheKey)
  if (cached !== null) {
    return cached === NO_AVATAR_SENTINEL ? null : cached
  }

  const dataUri = await buildBlurredAvatarDataUri(userId)
  await cache.setJSON(cacheKey, dataUri ?? NO_AVATAR_SENTINEL, ANON_AVATAR_TTL)
  return dataUri
}

async function buildBlurredAvatarDataUri(userId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ profilePhotoUrl: profiles.profilePhotoUrl })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1)

    if (!row?.profilePhotoUrl) return null

    const response = await fetch(row.profilePhotoUrl)
    if (!response.ok) return null
    const bytes = Buffer.from(await response.arrayBuffer())

    const blurred = await sharp(bytes)
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
      .blur(BLUR_SIGMA)
      .jpeg({ quality: 55 })
      .toBuffer()

    return `data:image/jpeg;base64,${blurred.toString('base64')}`
  } catch (e) {
    logger.debug?.({ err: e, userId }, 'getBlurredAvatarDataUri failed')
    return null
  }
}
