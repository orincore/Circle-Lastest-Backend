import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { requireAdmin, AdminRequest, logAdminAction } from '../middleware/adminAuth.js'
import { desc, eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { memeSources, memes, memeAssets } from '../db/schema.js'
import { cache, cacheKeys } from '../services/cache.js'

const router = Router()

const sourceToJson = (r: typeof memeSources.$inferSelect) => ({
  id: r.id,
  instagram_username: r.instagramUsername,
  display_name: r.displayName,
  is_active: r.isActive,
  scrape_interval_minutes: r.scrapeIntervalMinutes,
  last_scraped_at: r.lastScrapedAt,
  last_success_at: r.lastSuccessAt,
  consecutive_failures: r.consecutiveFailures,
  backoff_until: r.backoffUntil,
  status: r.status,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
})

const memeToJson = (r: typeof memes.$inferSelect, assets: (typeof memeAssets.$inferSelect)[] = []) => ({
  id: r.id,
  source_id: r.sourceId,
  instagram_shortcode: r.instagramShortcode,
  post_type: r.postType,
  caption: r.caption,
  like_count: r.likeCount,
  posted_at: r.postedAt,
  scraped_at: r.scrapedAt,
  status: r.status,
  created_at: r.createdAt,
  assets: assets
    .sort((a, b) => a.position - b.position)
    .map(a => ({
      id: a.id,
      asset_type: a.assetType,
      position: a.position,
      s3_url: a.s3Url,
      width: a.width,
      height: a.height,
      duration_seconds: a.durationSeconds,
      file_size_bytes: a.fileSizeBytes,
    })),
})

// List meme sources
router.get('/sources', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const rows = await db.select().from(memeSources).orderBy(desc(memeSources.createdAt))
    return res.json({ sources: rows.map(sourceToJson) })
  } catch (e) {
    console.error('admin memes list sources error:', e)
    return res.status(500).json({ error: 'Failed to list meme sources' })
  }
})

// Add a new Instagram profile to scrape
router.post('/sources', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { instagram_username, display_name, scrape_interval_minutes } = req.body || {}

    if (!instagram_username || typeof instagram_username !== 'string') {
      return res.status(400).json({ error: 'instagram_username is required' })
    }

    const insert = {
      instagramUsername: instagram_username.trim().toLowerCase().replace(/^@/, ''),
      displayName: display_name || null,
      scrapeIntervalMinutes: Number.isFinite(scrape_interval_minutes) ? scrape_interval_minutes : 60,
    }

    const [row] = await db.insert(memeSources).values(insert).returning()

    if (!row) {
      console.error('Create meme source error: no row returned')
      return res.status(500).json({ error: 'Failed to create meme source' })
    }

    await logAdminAction(req.user!.id, 'meme_source_create', 'meme_sources', row.id, insert)

    return res.json({ source: sourceToJson(row) })
  } catch (e: any) {
    if ((e?.code ?? e?.cause?.code) === '23505') {
      return res.status(409).json({ error: 'This Instagram username is already a source' })
    }
    console.error('admin memes create source error:', e)
    return res.status(500).json({ error: 'Failed to create meme source' })
  }
})

// Enable/disable, adjust interval, or manually clear backoff on a source
router.patch('/sources/:id', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { id } = req.params
    const payload = req.body || {}

    const update: any = {
      isActive: 'is_active' in payload ? !!payload.is_active : undefined,
      scrapeIntervalMinutes: 'scrape_interval_minutes' in payload ? payload.scrape_interval_minutes : undefined,
      displayName: 'display_name' in payload ? payload.display_name : undefined,
      updatedAt: new Date().toISOString(),
    }

    if (payload.clear_backoff) {
      update.status = 'active'
      update.backoffUntil = null
      update.consecutiveFailures = 0
    } else if ('status' in payload) {
      update.status = payload.status
    }

    const [row] = await db.update(memeSources).set(update).where(eq(memeSources.id, id)).returning()

    if (!row) {
      return res.status(404).json({ error: 'Meme source not found' })
    }

    await logAdminAction(req.user!.id, 'meme_source_update', 'meme_sources', id, update)

    return res.json({ source: sourceToJson(row) })
  } catch (e) {
    console.error('admin memes update source error:', e)
    return res.status(500).json({ error: 'Failed to update meme source' })
  }
})

// List scraped memes (with assets) for verification/moderation
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { status, limit = '50', offset = '0' } = req.query as any
    const lim = Math.min(parseInt(limit) || 50, 200)
    const off = Math.max(parseInt(offset) || 0, 0)

    const rows = await db.select()
      .from(memes)
      .where(status ? eq(memes.status, status) : undefined)
      .orderBy(desc(memes.createdAt))
      .limit(lim)
      .offset(off)

    if (rows.length === 0) {
      return res.json({ memes: [] })
    }

    const memeIds = rows.map(r => r.id)
    const assetRows = await db.select().from(memeAssets)

    const assetsByMeme = new Map<string, (typeof memeAssets.$inferSelect)[]>()
    for (const a of assetRows) {
      if (!memeIds.includes(a.memeId)) continue
      const list = assetsByMeme.get(a.memeId) || []
      list.push(a)
      assetsByMeme.set(a.memeId, list)
    }

    return res.json({ memes: rows.map(r => memeToJson(r, assetsByMeme.get(r.id) || [])) })
  } catch (e) {
    console.error('admin memes list error:', e)
    return res.status(500).json({ error: 'Failed to list memes' })
  }
})

// Moderate a meme: hide / flag / restore
router.patch('/:id', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { id } = req.params
    const { status } = req.body || {}

    if (!['active', 'hidden', 'flagged'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of active, hidden, flagged' })
    }

    const [row] = await db.update(memes).set({ status }).where(eq(memes.id, id)).returning()

    if (!row) {
      return res.status(404).json({ error: 'Meme not found' })
    }

    // The feed/single-meme endpoints cache this meme's content across every
    // viewer (see feed-memes.routes.ts) -- evict it so a hide/flag/restore
    // takes effect immediately instead of waiting out the cache TTL.
    await cache.del(cacheKeys.memeContent(id))

    await logAdminAction(req.user!.id, 'meme_moderate', 'memes', id, { status })

    return res.json({ meme: memeToJson(row) })
  } catch (e) {
    console.error('admin memes moderate error:', e)
    return res.status(500).json({ error: 'Failed to update meme' })
  }
})

export default router
