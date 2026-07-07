import { eq, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { memes } from '../db/schema.js'

/**
 * Lightweight meme-feed ranking.
 *
 * Two signals, both cheap to maintain:
 *
 * 1. `meme_stats.trending_score` (global, same for every viewer) -- an
 *    engagement-per-unit-time score recomputed in place on the single
 *    `meme_stats` row for a meme every time it receives a like/comment/
 *    share/view/dwell event. There is deliberately no periodic batch job:
 *    since there's exactly one stats row per meme, recomputing it inline at
 *    write-time is O(1) and keeps scores continuously fresh (which is exactly
 *    what "is this performing well in its first few minutes" needs) without
 *    the operational overhead of a cron/worker process.
 *
 * 2. `user_source_affinity` (per viewer) -- a running, bounded score of how
 *    much a given user engages with a given meme source, nudging their feed
 *    toward sources they respond to. Bounded so it can't grow unboundedly for
 *    very active users and so one heavy engager can't dominate ranking.
 *
 * The feed query (feed-memes.routes.ts) blends both: `trending_score *
 * (1 + clamped(affinity))`, plus a small random jitter so the order isn't
 * perfectly static across repeated calls, and a flat exploration bonus for
 * memes that haven't accumulated enough views to be judged on merit yet --
 * every meme gets an initial chance; only once it's had that chance does
 * (under-)performance start suppressing it.
 */

// --- Trending score ---------------------------------------------------

// Engagement weights: how much each event type counts toward "this is
// performing well". Shares are the strongest signal (an active recommendation
// to someone else), comments next, then likes, then raw watch time.
const SCORE_WEIGHTS = {
  like: 1,
  comment: 3,
  share: 5,
  dwellPerSecond: 0.02,
}

// Hacker-News-style time decay: score / (age_hours + offset) ^ gravity.
// Higher gravity makes the feed favor *recent* velocity over lifetime totals,
// which is what "performing within X minutes" is asking for.
const GRAVITY = 1.5
const AGE_OFFSET_HOURS = 2

// A meme with fewer than this many views hasn't had a fair chance to prove
// itself yet, so it gets a flat bonus on top of its (likely still-low)
// engagement score -- guarantees every post gets shown to *some* users
// before ranking starts judging it purely on performance.
const EXPLORATION_VIEW_THRESHOLD = 50
const EXPLORATION_BONUS = 2

async function recomputeTrendingScore(memeId: string): Promise<void> {
  await db.execute(sql`
    UPDATE meme_stats ms
    SET
      trending_score = (
        (ms.like_count * ${SCORE_WEIGHTS.like}
          + ms.comment_count * ${SCORE_WEIGHTS.comment}
          + ms.share_count * ${SCORE_WEIGHTS.share}
          + (ms.total_dwell_ms / 1000.0) * ${SCORE_WEIGHTS.dwellPerSecond}
        )
        / power(
            GREATEST(extract(epoch from (now() - COALESCE(m.posted_at, m.scraped_at))) / 3600.0, 0) + ${AGE_OFFSET_HOURS},
            ${GRAVITY}
          )
      ) + (CASE WHEN ms.view_count < ${EXPLORATION_VIEW_THRESHOLD} THEN ${EXPLORATION_BONUS} ELSE 0 END),
      updated_at = now()
    FROM memes m
    WHERE ms.meme_id = m.id AND ms.meme_id = ${memeId}
  `)
}

async function ensureStatsRow(memeId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO meme_stats (meme_id) VALUES (${memeId})
    ON CONFLICT (meme_id) DO NOTHING
  `)
}

async function bumpStat(memeId: string, column: 'like_count' | 'comment_count' | 'share_count' | 'view_count', delta: number): Promise<void> {
  await ensureStatsRow(memeId)
  // `column` is always one of the fixed literals above (never user input), so
  // this raw interpolation is safe -- kept as one shared helper rather than
  // four near-identical functions.
  await db.execute(sql`
    UPDATE meme_stats
    SET ${sql.raw(column)} = GREATEST(${sql.raw(column)} + ${delta}, 0), updated_at = now()
    WHERE meme_id = ${memeId}
  `)
  await recomputeTrendingScore(memeId)
}

async function bumpDwell(memeId: string, durationMs: number): Promise<void> {
  await ensureStatsRow(memeId)
  await db.execute(sql`
    UPDATE meme_stats
    SET total_dwell_ms = total_dwell_ms + ${durationMs}, updated_at = now()
    WHERE meme_id = ${memeId}
  `)
  await recomputeTrendingScore(memeId)
}

// --- Per-user source affinity ------------------------------------------

// How much each event type nudges a user's affinity for the meme's source.
// Bounded per-event (dwell capped at 30s worth) and bounded in total (see the
// clamp in bumpAffinity) so this stays a gentle nudge, not a runaway score.
const AFFINITY_WEIGHTS = {
  like: 3,
  unlike: -3,
  comment: 5,
  share: 8,
  dwellPerSecond: 0.05,
  dwellCapSeconds: 30,
}
const AFFINITY_MIN = -50
const AFFINITY_MAX = 500

async function getMemeSourceId(memeId: string): Promise<string | null> {
  const [row] = await db.select({ sourceId: memes.sourceId }).from(memes).where(eq(memes.id, memeId)).limit(1)
  return row?.sourceId ?? null
}

async function bumpAffinity(userId: string, sourceId: string, delta: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO user_source_affinity (user_id, source_id, affinity_score, updated_at)
    VALUES (${userId}, ${sourceId}, ${delta}, now())
    ON CONFLICT (user_id, source_id) DO UPDATE
      SET affinity_score = LEAST(GREATEST(user_source_affinity.affinity_score + ${delta}, ${AFFINITY_MIN}), ${AFFINITY_MAX}),
          updated_at = now()
  `)
}

// --- Public event hooks --------------------------------------------------
// One function per engagement event. Each is a couple of cheap, indexed
// UPSERTs (O(1) per event, no scans over other memes/users) -- call these
// from the relevant feed-memes.routes.ts handlers instead of writing to
// meme_stats/user_source_affinity directly, so the scoring formula and
// weights stay in this one file.

export async function onMemeLiked(memeId: string, userId: string): Promise<void> {
  await bumpStat(memeId, 'like_count', 1)
  const sourceId = await getMemeSourceId(memeId)
  if (sourceId) await bumpAffinity(userId, sourceId, AFFINITY_WEIGHTS.like)
}

export async function onMemeUnliked(memeId: string, userId: string): Promise<void> {
  await bumpStat(memeId, 'like_count', -1)
  const sourceId = await getMemeSourceId(memeId)
  if (sourceId) await bumpAffinity(userId, sourceId, AFFINITY_WEIGHTS.unlike)
}

export async function onMemeCommented(memeId: string, userId: string): Promise<void> {
  await bumpStat(memeId, 'comment_count', 1)
  const sourceId = await getMemeSourceId(memeId)
  if (sourceId) await bumpAffinity(userId, sourceId, AFFINITY_WEIGHTS.comment)
}

export async function onMemeShared(memeId: string, userId: string): Promise<void> {
  await bumpStat(memeId, 'share_count', 1)
  const sourceId = await getMemeSourceId(memeId)
  if (sourceId) await bumpAffinity(userId, sourceId, AFFINITY_WEIGHTS.share)
}

// A bare view is a weak signal on its own (auto-recorded for every card that
// scrolls past) -- it feeds the trending score, but deliberately doesn't bump
// personal affinity to avoid that being pure scroll-through noise.
export async function onMemeViewed(memeId: string): Promise<void> {
  await bumpStat(memeId, 'view_count', 1)
}

export async function onMemeDwell(memeId: string, userId: string, durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return
  await bumpDwell(memeId, durationMs)

  const sourceId = await getMemeSourceId(memeId)
  if (sourceId) {
    const cappedSeconds = Math.min(durationMs / 1000, AFFINITY_WEIGHTS.dwellCapSeconds)
    await bumpAffinity(userId, sourceId, cappedSeconds * AFFINITY_WEIGHTS.dwellPerSecond)
  }
}
