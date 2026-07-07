import { eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { userMemeAliases } from '../db/schema.js'
import { cache, cacheKeys, MEME_ALIAS_TTL } from './cache.js'

const ALIAS_PREFIX = 'circ'
const MAX_ATTEMPTS = 5

function randomSuffix(): string {
  return Math.random().toString(36).substring(2, 9)
}

/**
 * Returns this user's persistent anonymous alias for the meme feed, creating one
 * on first call. Never changes once created -- comments/likes/connect-requests
 * always resolve back to the same alias for a given user.
 */
export async function getOrCreateAlias(userId: string): Promise<string> {
  const cacheKey = cacheKeys.memeAlias(userId)
  const cached = await cache.getJSON<string>(cacheKey)
  if (cached) return cached

  const [existing] = await db.select().from(userMemeAliases).where(eq(userMemeAliases.userId, userId)).limit(1)
  if (existing) {
    await cache.setJSON(cacheKey, existing.alias, MEME_ALIAS_TTL)
    return existing.alias
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const alias = `${ALIAS_PREFIX}${randomSuffix()}`

    try {
      const [row] = await db
        .insert(userMemeAliases)
        .values({ userId, alias })
        .onConflictDoNothing({ target: userMemeAliases.userId })
        .returning()

      if (row) {
        await cache.setJSON(cacheKey, row.alias, MEME_ALIAS_TTL)
        return row.alias
      }

      // onConflictDoNothing on userId means another concurrent call already
      // created this user's alias -- fetch and return that one instead of retrying.
      const [raceWinner] = await db.select().from(userMemeAliases).where(eq(userMemeAliases.userId, userId)).limit(1)
      if (raceWinner) {
        await cache.setJSON(cacheKey, raceWinner.alias, MEME_ALIAS_TTL)
        return raceWinner.alias
      }
    } catch (e: any) {
      // Unique violation on the `alias` column itself (collision with a
      // different user) -- retry with a new random suffix.
      if ((e?.code ?? e?.cause?.code) !== '23505') throw e
    }
  }

  throw new Error('Failed to generate a unique meme alias after multiple attempts')
}

export async function getAliasByUserId(userId: string): Promise<string | null> {
  const [row] = await db.select().from(userMemeAliases).where(eq(userMemeAliases.userId, userId)).limit(1)
  return row?.alias ?? null
}
