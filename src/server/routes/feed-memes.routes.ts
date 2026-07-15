import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { memes, memeAssets, memeGenres, memeLikes, memeComments, memeShares, chatMembers, friendships, profiles } from '../db/schema.js'
import { getOrCreateAlias } from '../services/memeAlias.service.js'
import { getBlurredAvatarDataUri } from '../services/anonAvatar.service.js'
import { insertMessage, getChatById } from '../repos/chat.repo.js'
import { isMemeConnectChat } from '../services/memeConnect.service.js'
import { cache, cacheKeys, MEME_CONTENT_TTL, MEME_COMMENTS_TTL } from '../services/cache.js'
import { onMemeLiked, onMemeUnliked, onMemeCommented, onMemeShared, onMemeViewed, onMemeDwell } from '../services/memeRanking.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { MEME_GENRE_VALUES } from '../constants/memeGenres.js'

const router = Router()

const assetToJson = (a: typeof memeAssets.$inferSelect) => ({
  id: a.id,
  asset_type: a.assetType,
  position: a.position,
  s3_url: a.s3Url,
  width: a.width,
  height: a.height,
  duration_seconds: a.durationSeconds,
})

// Derives a stable anonymous poster identity per meme source (never the real
// scraped Instagram handle) -- a deterministic hash of `source_id`, no DB
// storage needed, so every meme from the same source always renders the same
// "poster", matching how a real creator's username stays consistent across
// their posts on Instagram Reels. Uses the exact same `circ` + 7-char base36
// suffix format as real users' anonymous aliases (see memeAlias.service.ts)
// so admin-seeded posters are visually indistinguishable from real ones.
function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash
}

function derivePosterAlias(sourceId: string): string {
  const hash = hashString(sourceId)
  const suffix = hash.toString(36).padStart(7, '0').slice(-7)
  return `circ${suffix}`
}

type MemeContent = {
  id: string
  instagram_shortcode: string | null
  post_type: string
  caption: string | null
  posted_at: string | null
  poster_alias: string
  uploader_user_id: string | null
  genres: string[]
  music: {
    youtube_video_id: string
    title: string | null
    channel_title: string | null
    start_seconds: number
    trim_seconds: number
  } | null
  assets: ReturnType<typeof assetToJson>[]
}

/**
 * Fetches the immutable parts of a meme (caption/assets/post_type) with a
 * Redis-backed cache shared across every viewer -- these never change once a
 * meme is scraped in, so they're safe to cache far more aggressively than the
 * live per-viewer fields (likes, comment counts) which are always computed
 * fresh. Only returns entries for memes that actually exist/are active.
 */
async function getMemeContentBatch(memeIds: string[]): Promise<Map<string, MemeContent>> {
  const result = new Map<string, MemeContent>()
  if (memeIds.length === 0) return result

  const missing: string[] = []
  await Promise.all(memeIds.map(async (id) => {
    const cached = await cache.getJSON<MemeContent>(cacheKeys.memeContent(id))
    if (cached) result.set(id, cached)
    else missing.push(id)
  }))

  if (missing.length > 0) {
    // Re-check `status = 'active'` on every cache-miss fetch (not just the
    // initial ID selection) -- otherwise a meme hidden/flagged after being
    // cached, then evicted (see admin-memes.routes.ts), would get re-cached
    // and served again on the next miss.
    const memeRows = await db.select().from(memes).where(and(inArray(memes.id, missing), eq(memes.status, 'active')))
    const assetRows = await db.select().from(memeAssets).where(inArray(memeAssets.memeId, missing))
    const genreRows = await db.select().from(memeGenres).where(inArray(memeGenres.memeId, missing))

    const assetsByMeme = new Map<string, ReturnType<typeof assetToJson>[]>()
    for (const a of assetRows) {
      const list = assetsByMeme.get(a.memeId) || []
      list.push(assetToJson(a))
      assetsByMeme.set(a.memeId, list)
    }

    const genresByMeme = new Map<string, string[]>()
    for (const g of genreRows) {
      const list = genresByMeme.get(g.memeId) || []
      list.push(g.genre)
      genresByMeme.set(g.memeId, list)
    }

    await Promise.all(memeRows.map(async (m) => {
      // User-uploaded memes have no source_id to derive a poster identity
      // from -- they use the uploader's own persistent anonymous alias
      // instead (same alias already shown on their comments), keeping the
      // feed's "anonymous poster" model consistent for both content types.
      const posterAlias = m.origin === 'user_upload' && m.uploaderUserId
        ? await getOrCreateAlias(m.uploaderUserId)
        : derivePosterAlias(m.sourceId!)

      const content: MemeContent = {
        id: m.id,
        instagram_shortcode: m.instagramShortcode,
        post_type: m.postType,
        caption: m.caption,
        posted_at: m.postedAt,
        poster_alias: posterAlias,
        uploader_user_id: m.uploaderUserId,
        genres: genresByMeme.get(m.id) || [],
        music: m.musicYoutubeVideoId ? {
          youtube_video_id: m.musicYoutubeVideoId,
          title: m.musicTitle,
          channel_title: m.musicChannelTitle,
          start_seconds: m.musicStartSeconds,
          trim_seconds: m.musicTrimSeconds,
        } : null,
        assets: (assetsByMeme.get(m.id) || []).sort((a, b) => a.position - b.position),
      }
      result.set(m.id, content)
      await cache.setJSON(cacheKeys.memeContent(m.id), content, MEME_CONTENT_TTL)
    }))
  }

  return result
}

// GET /api/feed/memes -- ranked feed excluding this user's already-viewed memes,
// backfilling with least-recently-seen once unseen content runs out. Client marks
// cards as viewed via POST /:id/view as they scroll past, so the next call here
// naturally excludes them -- no cursor bookkeeping needed.
//
// Ranking (see services/memeRanking.service.ts for how the two inputs are
// maintained): each meme's precomputed `trending_score` (engagement per unit
// time, with a flat bonus while it's still new enough to deserve a fair
// chance) multiplied by a clamped per-user `affinity` for that meme's source,
// plus a small random jitter so repeated calls don't return an identical
// order. This is a single ORDER BY over already-aggregated columns -- no
// per-request aggregation over the raw likes/comments/shares tables -- so it
// stays cheap regardless of how much engagement history exists.
//
// Real user-uploaded nudges (origin = 'user_upload') always rank ABOVE seeded
// (scraped) content: `ORDER BY (m.origin = 'user_upload') DESC` is the primary
// key in both queries below, so a page fills with user uploads first (ranked
// among themselves by the score below) and only falls back to seeded content
// once the user uploads for this viewer run out. It's a boolean sort key
// (TRUE sorts first under DESC) -- no extra join or per-row cost.
const FEED_AFFINITY_MIN = -0.3
const FEED_AFFINITY_MAX = 0.6
const FEED_AFFINITY_SCALE = 0.01
const FEED_GENRE_AFFINITY_MIN = -0.3
const FEED_GENRE_AFFINITY_MAX = 0.6
const FEED_GENRE_AFFINITY_SCALE = 0.01
const FEED_JITTER_BASE = 0.85
const FEED_JITTER_RANGE = 0.3
// `g.score` comes from the LATERAL join below -- the strongest of this
// viewer's affinities across whichever genres a meme carries (a meme can
// have 1-3 genres; MAX picks the one that best predicts their interest).
const FEED_RANK_EXPR = sql`
  (COALESCE(ms.trending_score, 2) *
    (1 + LEAST(GREATEST(COALESCE(a.affinity_score, 0) * ${FEED_AFFINITY_SCALE}, ${FEED_AFFINITY_MIN}), ${FEED_AFFINITY_MAX})) *
    (1 + LEAST(GREATEST(COALESCE(g.score, 0) * ${FEED_GENRE_AFFINITY_SCALE}, ${FEED_GENRE_AFFINITY_MIN}), ${FEED_GENRE_AFFINITY_MAX})) *
    (${FEED_JITTER_BASE} + random() * ${FEED_JITTER_RANGE})
  )
`
// Joined into both feed queries below alongside the existing source-affinity
// join -- same LEFT JOIN LATERAL for every row, cheap since it's indexed on
// (meme_genres.meme_id) and (user_genre_affinity.user_id, genre). A function
// (not a constant) because it interpolates the per-request userId, same as
// the existing user_source_affinity joins below.
const genreAffinityJoin = (userId: string) => sql`
  LEFT JOIN LATERAL (
    SELECT MAX(ga.affinity_score) AS score
    FROM meme_genres mg
    JOIN user_genre_affinity ga ON ga.user_id = ${userId} AND ga.genre = mg.genre
    WHERE mg.meme_id = m.id
  ) g ON true
`

router.get('/memes', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const limit = Math.min(parseInt((req.query.limit as string) || '20') || 20, 50)
    const genreFilter = typeof req.query.genre === 'string' && MEME_GENRE_VALUES.has(req.query.genre) ? req.query.genre : null
    const genreFilterClause = genreFilter
      ? sql`AND EXISTS (SELECT 1 FROM meme_genres mg2 WHERE mg2.meme_id = m.id AND mg2.genre = ${genreFilter})`
      : sql``

    const unseenRows = await db.execute(sql`
      SELECT m.id FROM memes m
      LEFT JOIN meme_stats ms ON ms.meme_id = m.id
      LEFT JOIN user_source_affinity a ON a.user_id = ${userId} AND a.source_id = m.source_id
      ${genreAffinityJoin(userId)}
      WHERE m.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM meme_feed_views v WHERE v.meme_id = m.id AND v.user_id = ${userId}
        )
        ${genreFilterClause}
      ORDER BY (m.origin = 'user_upload') DESC, ${FEED_RANK_EXPR} DESC
      LIMIT ${limit}
    `)

    let memeIds = unseenRows.rows.map((r: any) => r.id as string)

    if (memeIds.length < limit) {
      const backfillRows = await db.execute(sql`
        SELECT m.id FROM memes m
        LEFT JOIN meme_feed_views v ON v.meme_id = m.id AND v.user_id = ${userId}
        LEFT JOIN meme_stats ms ON ms.meme_id = m.id
        LEFT JOIN user_source_affinity a ON a.user_id = ${userId} AND a.source_id = m.source_id
        ${genreAffinityJoin(userId)}
        WHERE m.status = 'active'
          ${memeIds.length > 0 ? sql`AND m.id NOT IN (${sql.join(memeIds, sql`, `)})` : sql``}
          ${genreFilterClause}
        ORDER BY (m.origin = 'user_upload') DESC, v.viewed_at ASC NULLS FIRST, ${FEED_RANK_EXPR} DESC
        LIMIT ${limit - memeIds.length}
      `)
      memeIds = memeIds.concat(backfillRows.rows.map((r: any) => r.id as string))
    }

    if (memeIds.length === 0) {
      return res.json({ memes: [] })
    }

    const contentByMeme = await getMemeContentBatch(memeIds)
    const likeCountRows = await db.select({ memeId: memeLikes.memeId, c: sql<number>`count(*)::int` })
      .from(memeLikes)
      .where(inArray(memeLikes.memeId, memeIds))
      .groupBy(memeLikes.memeId)
    const myLikeRows = await db.select({ memeId: memeLikes.memeId }).from(memeLikes)
      .where(and(inArray(memeLikes.memeId, memeIds), eq(memeLikes.userId, userId)))
    const commentCountRows = await db.select({ memeId: memeComments.memeId, c: sql<number>`count(*)::int` })
      .from(memeComments)
      .where(and(inArray(memeComments.memeId, memeIds), eq(memeComments.status, 'active')))
      .groupBy(memeComments.memeId)

    const likeCountByMeme = new Map<string, number>(likeCountRows.map(r => [r.memeId, r.c]))
    const commentCountByMeme = new Map<string, number>(commentCountRows.map(r => [r.memeId, r.c]))
    const likedByMe = new Set(myLikeRows.map(r => r.memeId))

    return res.json({
      memes: memeIds
        .map(id => {
          const content = contentByMeme.get(id)
          if (!content) return null
          return {
            ...content,
            like_count: likeCountByMeme.get(id) || 0,
            comment_count: commentCountByMeme.get(id) || 0,
            liked_by_me: likedByMe.has(id),
            is_own: content.uploader_user_id === userId,
          }
        })
        .filter((m): m is NonNullable<typeof m> => !!m),
    })
  } catch (e) {
    console.error('feed memes list error:', e)
    return res.status(500).json({ error: 'Failed to load feed' })
  }
})

// GET /api/feed/memes/:id -- single meme. Used both for rendering a
// shared-meme preview card in a chat message, and for deep-linking a shared
// meme straight into the feed screen (tapping that preview card) -- the
// latter renders this through the exact same <MemeCard> as the list
// endpoint, so the shape here has to match it exactly (comment_count,
// liked_by_me), not just the like_count the preview card alone needed.
router.get('/memes/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params

    const contentByMeme = await getMemeContentBatch([id])
    const content = contentByMeme.get(id)
    if (!content) {
      return res.status(404).json({ error: 'Meme not found' })
    }

    const [{ c: likeCount }] = (await db.execute(sql`SELECT count(*)::int as c FROM meme_likes WHERE meme_id = ${id}`)).rows as any
    const [{ c: commentCount }] = (await db.execute(sql`SELECT count(*)::int as c FROM meme_comments WHERE meme_id = ${id} AND status = 'active'`)).rows as any
    const [likedRow] = await db.select({ memeId: memeLikes.memeId }).from(memeLikes)
      .where(and(eq(memeLikes.memeId, id), eq(memeLikes.userId, userId)))
      .limit(1)

    return res.json({
      meme: {
        ...content,
        like_count: likeCount,
        comment_count: commentCount,
        liked_by_me: !!likedRow,
        is_own: content.uploader_user_id === userId,
      },
    })
  } catch (e) {
    console.error('feed single meme error:', e)
    return res.status(500).json({ error: 'Failed to load meme' })
  }
})

// POST /api/feed/memes/:id/view -- client calls this as a card becomes visible.
router.post('/memes/:id/view', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params

    await db.execute(sql`
      INSERT INTO meme_feed_views (user_id, meme_id, viewed_at)
      VALUES (${userId}, ${id}, now())
      ON CONFLICT (user_id, meme_id) DO UPDATE SET viewed_at = now()
    `)
    await onMemeViewed(id)

    return res.json({ success: true })
  } catch (e) {
    console.error('feed view error:', e)
    return res.status(500).json({ error: 'Failed to record view' })
  }
})

// POST /api/feed/memes/:id/view-duration -- client calls this once a card
// loses focus (scrolled past), with how long it was actually on screen.
// Feeds both the meme's trending score and this viewer's source affinity
// (see memeRanking.service.ts) -- this is the "time spent" signal, separate
// from the binary "was it seen at all" /view above.
router.post('/memes/:id/view-duration', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params
    const durationMs = Math.round(Number(req.body?.duration_ms))

    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      return res.status(400).json({ error: 'duration_ms must be a positive number' })
    }
    // Reject implausible single-event durations (e.g. a stale timer from a
    // backgrounded app) rather than letting one bad client event skew a
    // meme's score -- 10 minutes is far beyond how long any one feed card
    // would realistically stay focused.
    const cappedMs = Math.min(durationMs, 10 * 60 * 1000)

    await db.execute(sql`
      UPDATE meme_feed_views SET duration_ms = duration_ms + ${cappedMs}
      WHERE user_id = ${userId} AND meme_id = ${id}
    `)
    await onMemeDwell(id, userId, cappedMs)

    return res.json({ success: true })
  } catch (e) {
    console.error('feed view-duration error:', e)
    return res.status(500).json({ error: 'Failed to record view duration' })
  }
})

// POST/DELETE /api/feed/memes/:id/like -- toggle, unique constraint makes a double-like a no-op.
router.post('/memes/:id/like', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params

    const [inserted] = await db.insert(memeLikes).values({ memeId: id, userId }).onConflictDoNothing().returning()
    if (inserted) await onMemeLiked(id, userId)

    const [{ c }] = (await db.execute(sql`SELECT count(*)::int as c FROM meme_likes WHERE meme_id = ${id}`)).rows as any
    return res.json({ liked: true, like_count: c })
  } catch (e: any) {
    if ((e?.code ?? e?.cause?.code) === '23503') {
      return res.status(404).json({ error: 'Meme not found' })
    }
    console.error('feed like error:', e)
    return res.status(500).json({ error: 'Failed to like' })
  }
})

router.delete('/memes/:id/like', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params

    const deleted = await db.delete(memeLikes).where(and(eq(memeLikes.memeId, id), eq(memeLikes.userId, userId))).returning()
    if (deleted.length > 0) await onMemeUnliked(id, userId)

    const [{ c }] = (await db.execute(sql`SELECT count(*)::int as c FROM meme_likes WHERE meme_id = ${id}`)).rows as any
    return res.json({ liked: false, like_count: c })
  } catch (e) {
    console.error('feed unlike error:', e)
    return res.status(500).json({ error: 'Failed to unlike' })
  }
})

// GET/POST /api/feed/memes/:id/comments -- always rendered under the commenter's
// alias. Threaded one level deep (Instagram-style): top-level comments are
// paginated, each carrying its full `replies` array inline (a meme comment
// section realistically never has enough replies-per-comment for that to be
// worth its own pagination endpoint).
type CommentRow = {
  id: string
  text: string | null
  created_at: string
  alias: string
  avatar: string | null
  status: string
  user_id: string
  parent_comment_id: string | null
}

function toClientComment(r: CommentRow, viewerId: string) {
  const { user_id, parent_comment_id, ...rest } = r
  return {
    ...rest,
    // Once deleted, the text is never sent back to any client again (not just
    // hidden by the UI) -- the row is kept only so replies underneath it don't
    // look orphaned.
    text: r.status === 'deleted' ? null : r.text,
    is_own: user_id === viewerId,
  }
}

router.get('/memes/:id/comments', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const viewerId = req.user!.id
    const limit = Math.min(parseInt((req.query.limit as string) || '30') || 30, 100)
    const offset = Math.max(parseInt((req.query.offset as string) || '0') || 0, 0)

    // The cached page is shared across every viewer, so it carries the raw
    // `user_id` (never sent to the client -- see memeConnect.service.ts on why
    // real ids stay server-side) purely so `is_own` can be computed per-viewer
    // after the cache read, instead of baking a viewer-specific flag into a
    // shared cache entry.
    const cacheKey = cacheKeys.memeComments(id, limit, offset)
    let cached = await cache.getJSON<{ top: CommentRow[]; repliesByParent: Record<string, CommentRow[]> }>(cacheKey)

    if (!cached) {
      const topRows = await db.select().from(memeComments)
        .where(and(eq(memeComments.memeId, id), isNull(memeComments.parentCommentId)))
        .orderBy(desc(memeComments.createdAt))
        .limit(limit)
        .offset(offset)

      const topIds = topRows.map(r => r.id)
      const replyRows = topIds.length > 0
        ? await db.select().from(memeComments)
            .where(inArray(memeComments.parentCommentId, topIds))
            .orderBy(memeComments.createdAt)
        : []

      const rowToCommentRow = async (r: typeof memeComments.$inferSelect): Promise<CommentRow> => ({
        id: r.id,
        text: r.text,
        created_at: r.createdAt,
        alias: await getOrCreateAlias(r.userId),
        avatar: await getBlurredAvatarDataUri(r.userId),
        status: r.status,
        user_id: r.userId,
        parent_comment_id: r.parentCommentId,
      })

      const top = await Promise.all(topRows.map(rowToCommentRow))
      const replies = await Promise.all(replyRows.map(rowToCommentRow))

      const repliesByParent: Record<string, CommentRow[]> = {}
      for (const r of replies) {
        const key = r.parent_comment_id!
        ;(repliesByParent[key] ||= []).push(r)
      }

      cached = { top, repliesByParent }
      await cache.setJSON(cacheKey, cached, MEME_COMMENTS_TTL)
    }

    const comments = cached.top
      // A soft-deleted top-level comment with no surviving replies has nothing
      // left to show -- drop it. One with replies stays (as "[deleted]") so
      // the replies underneath don't look orphaned.
      .filter(c => c.status !== 'deleted' || (cached!.repliesByParent[c.id]?.length ?? 0) > 0)
      .map(c => ({
        ...toClientComment(c, viewerId),
        replies: (cached!.repliesByParent[c.id] || []).map(r => toClientComment(r, viewerId)),
      }))

    return res.json({ comments })
  } catch (e) {
    console.error('feed comments list error:', e)
    return res.status(500).json({ error: 'Failed to load comments' })
  }
})

router.post('/memes/:id/comments', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params
    const { text, parent_comment_id } = req.body || {}

    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' })
    }
    if (text.length > 1000) {
      return res.status(400).json({ error: 'text is too long (max 1000 characters)' })
    }

    let resolvedParentId: string | null = null
    if (parent_comment_id) {
      if (typeof parent_comment_id !== 'string') {
        return res.status(400).json({ error: 'parent_comment_id must be a string' })
      }
      const [parent] = await db.select().from(memeComments).where(eq(memeComments.id, parent_comment_id)).limit(1)
      if (!parent || parent.memeId !== id) {
        return res.status(404).json({ error: 'Parent comment not found' })
      }
      // Replying to a reply still nests under its top-level ancestor -- Instagram-style,
      // one level of nesting max, enforced here rather than by the schema.
      resolvedParentId = parent.parentCommentId ?? parent.id
    }

    const [row] = await db.insert(memeComments).values({
      memeId: id,
      userId,
      text: text.trim(),
      parentCommentId: resolvedParentId,
    }).returning()
    const [aliasName, avatar] = await Promise.all([
      getOrCreateAlias(userId),
      getBlurredAvatarDataUri(userId),
      onMemeCommented(id, userId),
    ])

    await cache.delByPrefix(cacheKeys.memeCommentsPrefix(id))

    return res.json({
      comment: {
        id: row.id,
        text: row.text,
        created_at: row.createdAt,
        alias: aliasName,
        avatar,
        status: row.status,
        is_own: true,
        parent_comment_id: row.parentCommentId,
      },
    })
  } catch (e: any) {
    if ((e?.code ?? e?.cause?.code) === '23503') {
      return res.status(404).json({ error: 'Meme not found' })
    }
    console.error('feed comment create error:', e)
    return res.status(500).json({ error: 'Failed to post comment' })
  }
})

// DELETE /api/feed/memes/:id/comments/:commentId -- soft delete, own comments only.
router.delete('/memes/:id/comments/:commentId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id, commentId } = req.params

    const [comment] = await db.select().from(memeComments).where(eq(memeComments.id, commentId)).limit(1)
    if (!comment || comment.memeId !== id) {
      return res.status(404).json({ error: 'Comment not found' })
    }
    if (comment.userId !== userId) {
      return res.status(403).json({ error: 'You can only delete your own comments' })
    }

    await db.update(memeComments).set({ status: 'deleted' }).where(eq(memeComments.id, commentId))
    await cache.delByPrefix(cacheKeys.memeCommentsPrefix(id))

    return res.json({ success: true })
  } catch (e) {
    console.error('feed comment delete error:', e)
    return res.status(500).json({ error: 'Failed to delete comment' })
  }
})

// GET /api/feed/me/alias
router.get('/me/alias', requireAuth, async (req: AuthRequest, res) => {
  try {
    const aliasName = await getOrCreateAlias(req.user!.id)
    return res.json({ alias: aliasName })
  } catch (e) {
    console.error('feed get alias error:', e)
    return res.status(500).json({ error: 'Failed to get alias' })
  }
})

// POST /api/feed/memes/:id/share -- shares a meme into an existing chat (friend or
// accepted connect-request chat). Reuses the existing insertMessage() with the new
// additive shared_meme_id column rather than a separate message-send path.
router.post('/memes/:id/share', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id: memeId } = req.params
    const { chat_id } = req.body || {}

    if (!chat_id || typeof chat_id !== 'string') {
      return res.status(400).json({ error: 'chat_id is required' })
    }

    const [meme] = await db.select({ id: memes.id }).from(memes).where(eq(memes.id, memeId)).limit(1)
    if (!meme) {
      return res.status(404).json({ error: 'Meme not found' })
    }

    const members = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chat_id))
    if (members.length < 2 || !members.some(m => m.userId === userId)) {
      return res.status(403).json({ error: 'Not a member of this chat' })
    }
    const chat = await getChatById(chat_id)
    const isGroup = !!chat?.is_group
    if (!isGroup && members.length !== 2) {
      return res.status(403).json({ error: 'Not a member of this chat' })
    }
    const recipientIds = members.map(m => m.userId).filter(id => id !== userId)
    const otherUserId = recipientIds[0]

    // Groups are explicit, named, always-known-person chats -- skip the
    // friendship/connect-chat gate entirely (mirrors chat.routes.ts).
    if (!isGroup) {
      const isConnectChat = await isMemeConnectChat(chat_id)
      if (!isConnectChat) {
        const smallerId = userId < otherUserId ? userId : otherUserId
        const largerId = userId < otherUserId ? otherUserId : userId
        const [friendship] = await db.select({ status: friendships.status }).from(friendships)
          .where(and(eq(friendships.user1Id, smallerId), eq(friendships.user2Id, largerId)))
          .limit(1)
        if (!friendship || (friendship.status !== 'active' && friendship.status !== 'accepted')) {
          return res.status(403).json({ error: 'Can only share to a friend or an active connect chat' })
        }
      }
    }

    const message = await insertMessage(chat_id, userId, '', undefined, undefined, undefined, undefined, undefined, memeId)
    await db.insert(memeShares).values({ memeId, userId })
    await onMemeShared(memeId, userId)

    // `insertMessage` only writes the row -- unlike POST /:chatId/messages
    // (chat.routes.ts), nothing here previously emitted a socket event, so a
    // shared meme never reached the recipient's (or sender's other devices')
    // chat list in real time; it only appeared after a manual reload hit the
    // REST inbox endpoint. Mirrors chat.routes.ts's emit shape exactly so the
    // chat list's existing reorder-on-`chat:message` logic just works.
    try {
      const [senderInfo] = await db.select({
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        username: profiles.username,
        email: profiles.email,
        profilePhotoUrl: profiles.profilePhotoUrl,
      }).from(profiles).where(eq(profiles.id, userId)).limit(1)

      const senderName = senderInfo
        ? (senderInfo.firstName && senderInfo.lastName
            ? `${senderInfo.firstName} ${senderInfo.lastName}`.trim()
            : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
        : 'Someone'

      const messagePayload = {
        id: message.id,
        chatId: message.chat_id,
        senderId: message.sender_id,
        text: message.text,
        mediaUrl: message.media_url,
        mediaType: message.media_type,
        thumbnail: message.thumbnail,
        sharedMemeId: message.shared_meme_id,
        createdAt: new Date(message.created_at).getTime(),
        status: 'sent',
        senderName,
        senderAvatar: senderInfo?.profilePhotoUrl || null,
        isBlindDateChat: false,
        ...(isGroup ? { isGroup: true, groupName: chat?.group_name } : {}),
      }

      for (const recipientId of recipientIds) {
        emitToUser(recipientId, 'chat:message', { message: messagePayload })
        emitToUser(recipientId, 'chat:message:background', { message: messagePayload })
      }
      emitToUser(userId, 'chat:message', { message: messagePayload })

      for (const recipientId of recipientIds) {
        const [{ c: unreadCount }] = (await db.execute(sql`
          SELECT count(*)::int as c FROM messages m
          WHERE m.chat_id = ${chat_id}
            AND m.is_deleted = false
            AND m.sender_id != ${recipientId}
            AND NOT EXISTS (
              SELECT 1 FROM message_receipts r
              WHERE r.message_id = m.id AND r.user_id = ${recipientId} AND r.status = 'read'
            )
        `)).rows as any
        emitToUser(recipientId, 'chat:unread_count', { chatId: chat_id, unreadCount })
      }

      // Push notification to the receiver(s) -- this endpoint only ever emitted
      // live socket events above, which reach nothing if the recipient's app
      // isn't open (no active socket connection). Every other message-send
      // path (POST /:chatId/messages in chat.routes.ts, and the socket
      // chat:message handler in optimized-socket.ts) calls this; this share
      // endpoint never did, so a shared meme silently never notified an
      // offline/backgrounded/closed-app recipient.
      try {
        const { PushNotificationService, describeMessageForNotification } = await import('../services/pushNotificationService.js')
        const pushTitle = isGroup && chat?.group_name ? `${senderName} in ${chat.group_name}` : senderName
        await Promise.all(recipientIds.map((recipientId) => PushNotificationService.sendMessageNotification(
          recipientId,
          pushTitle,
          describeMessageForNotification({ sharedMemeId: message.shared_meme_id }),
          chat_id,
          message.id,
          userId,
          senderInfo?.profilePhotoUrl || null
        )))
      } catch (pushError) {
        console.error('feed share push notification error:', pushError)
      }
    } catch (emitError) {
      // A failure here shouldn't fail the share itself -- the message is
      // already persisted and will show up on the recipient's next reload.
      console.error('feed share realtime emit error:', emitError)
    }

    return res.json({ message })
  } catch (e) {
    console.error('feed share error:', e)
    return res.status(500).json({ error: 'Failed to share meme' })
  }
})

// GET /api/feed/share-counts?chat_ids=uuid1,uuid2,... -- how many memes have
// been shared (either direction) in each of these chats. Used by the share
// modal to sort its target list by "shared the most memes with" -- most-used
// contacts float to the top instead of a fixed/alphabetical order. Only
// counts chats the requester is actually a member of, so this can't be used
// to probe activity on an arbitrary chat_id.
router.get('/share-counts', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const chatIds = [...new Set(String(req.query.chat_ids || '').split(',').map(s => s.trim()).filter(Boolean))]
    if (chatIds.length === 0) {
      return res.json({ counts: {} })
    }

    const rows = await db.execute(sql`
      SELECT m.chat_id, count(*)::int as c
      FROM messages m
      WHERE m.chat_id IN (${sql.join(chatIds.map(id => sql`${id}`), sql`, `)})
        AND m.shared_meme_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = m.chat_id AND cm.user_id = ${userId})
      GROUP BY m.chat_id
    `)

    const counts: Record<string, number> = {}
    for (const row of rows.rows as any[]) counts[row.chat_id] = row.c
    return res.json({ counts })
  } catch (e) {
    console.error('feed share-counts error:', e)
    return res.status(500).json({ error: 'Failed to load share counts' })
  }
})

export default router
