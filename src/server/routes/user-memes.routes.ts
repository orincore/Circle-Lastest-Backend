import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import multer from 'multer'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import sharp from 'sharp'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import { eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { s3 } from '../config/s3.js'
import { env } from '../config/env.js'
import { memes, memeAssets, memeGenres } from '../db/schema.js'
import { MEME_GENRES, MEME_GENRE_VALUES, MIN_MEME_GENRES, MAX_MEME_GENRES } from '../constants/memeGenres.js'
import { searchYoutube } from '../services/youtube.service.js'

const router = Router()

const BUCKET_NAME = env.AWS_S3_BUCKET || 'media.orincore.com'
const MAX_IMAGES = 10
const MAX_FILE_SIZE_BYTES = 60 * 1024 * 1024 // headroom above the client's ~45MB video compression target
const CAPTION_MAX_LENGTH = 2200
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/
const ALLOWED_TRIM_SECONDS = [15, 30, 60]

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: MAX_IMAGES + 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true)
    else cb(new Error('Only image and video files are allowed'))
  },
})

// GET /api/feed/genres -- canonical genre list clients pick from. Never
// hardcoded on the client so the taxonomy can change server-side only.
router.get('/genres', requireAuth, async (_req: AuthRequest, res) => {
  res.json({ genres: MEME_GENRES })
})

// GET /api/feed/music-search?q= -- reuses the same YouTube Data API wrapper
// jam-session's search already uses (server-side key, Redis-cached).
router.get('/music-search', requireAuth, async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) return res.json({ results: [] })
    const results = await searchYoutube(q, { musicOnly: true })
    res.json({ results })
  } catch (error: any) {
    console.error('Meme music search error:', error)
    res.status(error?.status ?? 500).json({ error: error?.message ?? 'Search failed' })
  }
})

function parseGenres(raw: unknown): string[] | null {
  let values: unknown
  if (typeof raw === 'string') {
    try {
      values = JSON.parse(raw)
    } catch {
      values = raw.split(',').map((s) => s.trim()).filter(Boolean)
    }
  } else {
    values = raw
  }
  if (!Array.isArray(values)) return null
  const unique = [...new Set(values.map((v) => String(v)))]
  if (unique.length < MIN_MEME_GENRES || unique.length > MAX_MEME_GENRES) return null
  if (!unique.every((g) => MEME_GENRE_VALUES.has(g))) return null
  return unique
}

function extensionFor(mimetype: string): string {
  if (mimetype === 'image/png') return '.png'
  if (mimetype === 'image/webp') return '.webp'
  if (mimetype.startsWith('video/')) return '.mp4'
  return '.jpg'
}

// POST /api/feed/memes -- create a user-uploaded meme (photo carousel or
// single video), reusing the same memes/meme_assets tables scraped content
// lives in so the feed, ranking, likes/comments/share all just work.
router.post(
  '/memes',
  requireAuth,
  upload.fields([
    { name: 'media', maxCount: MAX_IMAGES },
    { name: 'thumbnail', maxCount: 1 },
  ]),
  async (req: AuthRequest, res) => {
    try {
      if (!s3 || !BUCKET_NAME) {
        return res.status(503).json({ error: 'Storage not configured' })
      }

      const userId = req.user!.id
      const files = req.files as { [field: string]: Express.Multer.File[] } | undefined
      const mediaFiles = files?.media ?? []
      const thumbnailFile = files?.thumbnail?.[0]

      if (mediaFiles.length === 0) {
        return res.status(400).json({ error: 'At least one photo or one video is required' })
      }

      const videoFiles = mediaFiles.filter((f) => f.mimetype.startsWith('video/'))
      const imageFiles = mediaFiles.filter((f) => f.mimetype.startsWith('image/'))

      if (videoFiles.length > 0 && (videoFiles.length > 1 || imageFiles.length > 0)) {
        return res.status(400).json({ error: 'Upload either 1 video or up to 10 photos, not both' })
      }
      if (imageFiles.length > MAX_IMAGES) {
        return res.status(400).json({ error: `Maximum ${MAX_IMAGES} photos per meme` })
      }

      const postType = videoFiles.length === 1 ? 'video' : imageFiles.length > 1 ? 'carousel' : 'image'

      const caption = typeof req.body?.caption === 'string' ? req.body.caption.trim() : ''
      if (caption.length > CAPTION_MAX_LENGTH) {
        return res.status(400).json({ error: `Caption is too long (max ${CAPTION_MAX_LENGTH} characters)` })
      }

      const genres = parseGenres(req.body?.genres)
      if (!genres) {
        return res.status(400).json({ error: `Select ${MIN_MEME_GENRES}-${MAX_MEME_GENRES} genres` })
      }

      // Music is optional. When present, videoId/title are required (they
      // come straight from a music-search result the client already has);
      // start/trim are validated defensively even though the client's UI
      // already constrains them.
      const musicVideoId = typeof req.body?.music_youtube_video_id === 'string' ? req.body.music_youtube_video_id.trim() : ''
      let musicFields: {
        musicYoutubeVideoId: string | null
        musicTitle: string | null
        musicChannelTitle: string | null
        musicDurationSeconds: number | null
        musicStartSeconds: number
        musicTrimSeconds: number
      } | null = null

      if (musicVideoId) {
        if (!YOUTUBE_ID_RE.test(musicVideoId)) {
          return res.status(400).json({ error: 'Invalid music track' })
        }
        const musicTitle = typeof req.body?.music_title === 'string' ? req.body.music_title.trim().slice(0, 500) : ''
        if (!musicTitle) {
          return res.status(400).json({ error: 'Music track title is required' })
        }
        const musicDurationSeconds = req.body?.music_duration_seconds != null ? parseInt(req.body.music_duration_seconds, 10) : null
        let musicStartSeconds = parseInt(req.body?.music_start_seconds ?? '0', 10)
        let musicTrimSeconds = parseInt(req.body?.music_trim_seconds ?? '15', 10)

        if (!Number.isFinite(musicStartSeconds) || musicStartSeconds < 0) musicStartSeconds = 0
        if (!ALLOWED_TRIM_SECONDS.includes(musicTrimSeconds)) musicTrimSeconds = 15
        if (Number.isFinite(musicDurationSeconds as number) && (musicDurationSeconds as number) > 0) {
          // Clamp the trim window to fit inside the actual track length.
          musicTrimSeconds = Math.min(musicTrimSeconds, musicDurationSeconds as number)
          musicStartSeconds = Math.min(musicStartSeconds, Math.max((musicDurationSeconds as number) - musicTrimSeconds, 0))
        }

        musicFields = {
          musicYoutubeVideoId: musicVideoId,
          musicTitle,
          musicChannelTitle: typeof req.body?.music_channel_title === 'string' ? req.body.music_channel_title.trim().slice(0, 200) : null,
          musicDurationSeconds: Number.isFinite(musicDurationSeconds as number) ? (musicDurationSeconds as number) : null,
          musicStartSeconds,
          musicTrimSeconds,
        }
      }

      const memeId = uuidv4()
      const orderedFiles = postType === 'video' ? videoFiles : imageFiles

      // Upload every asset to S3 in parallel, then insert DB rows only once
      // every upload has actually succeeded -- avoids DB rows pointing at
      // S3 objects that never landed.
      const uploadedAssets = await Promise.all(
        orderedFiles.map(async (file, position) => {
          let buffer = file.buffer
          let contentType = file.mimetype

          if (file.mimetype.startsWith('image/')) {
            buffer = await sharp(file.buffer)
              .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toBuffer()
            contentType = 'image/jpeg'
          }

          const assetType = file.mimetype.startsWith('video/') ? 'video' : 'image'
          const key = `Circle/user-memes/${userId}/${memeId}/${position}-${assetType}${extensionFor(contentType)}`
          await s3!.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType }))

          return {
            assetType,
            position,
            s3Key: key,
            s3Url: `https://${BUCKET_NAME}/${key}`,
            fileSizeBytes: buffer.length,
          }
        })
      )

      let thumbnailAsset: (typeof uploadedAssets)[number] | null = null
      if (postType === 'video' && thumbnailFile) {
        const buffer = await sharp(thumbnailFile.buffer)
          .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer()
        const key = `Circle/user-memes/${userId}/${memeId}/0-thumbnail.jpg`
        await s3!.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: key, Body: buffer, ContentType: 'image/jpeg' }))
        thumbnailAsset = { assetType: 'thumbnail', position: 0, s3Key: key, s3Url: `https://${BUCKET_NAME}/${key}`, fileSizeBytes: buffer.length }
      }

      const now = new Date().toISOString()

      await db.transaction(async (tx) => {
        await tx.insert(memes).values({
          id: memeId,
          sourceId: null,
          uploaderUserId: userId,
          origin: 'user_upload',
          instagramShortcode: `user-${memeId}`,
          postType,
          caption: caption || null,
          postedAt: now,
          status: 'active',
          ...(musicFields ?? {}),
        } as any)

        const assetRows = [...uploadedAssets, ...(thumbnailAsset ? [thumbnailAsset] : [])].map((a) => ({
          memeId,
          assetType: a.assetType,
          position: a.position,
          s3Key: a.s3Key,
          s3Url: a.s3Url,
          fileSizeBytes: a.fileSizeBytes,
        }))
        await tx.insert(memeAssets).values(assetRows)

        await tx.insert(memeGenres).values(genres.map((genre) => ({ memeId, genre })))
      })

      return res.status(201).json({ meme_id: memeId })
    } catch (error: any) {
      if (error?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large' })
      }
      console.error('Create user meme error:', error)
      return res.status(500).json({ error: 'Failed to create meme' })
    }
  }
)

// DELETE /api/feed/memes/:id -- owner-only soft delete (matches admin
// moderation semantics: status='hidden' behaves identically everywhere else
// in the feed as an admin-hidden post).
router.delete('/memes/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params

    const [meme] = await db.select({ uploaderUserId: memes.uploaderUserId }).from(memes).where(eq(memes.id, id)).limit(1)
    if (!meme) {
      return res.status(404).json({ error: 'Meme not found' })
    }
    if (meme.uploaderUserId !== userId) {
      return res.status(403).json({ error: 'You can only delete your own memes' })
    }

    await db.update(memes).set({ status: 'hidden' }).where(eq(memes.id, id))
    return res.json({ success: true })
  } catch (error) {
    console.error('Delete user meme error:', error)
    return res.status(500).json({ error: 'Failed to delete meme' })
  }
})

// GET /api/feed/my-memes -- the current user's own uploads, any status
// (so they can see their own hidden/flagged posts too).
router.get('/my-memes', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const rows = await db.select().from(memes).where(eq(memes.uploaderUserId, userId)).orderBy(memes.createdAt)

    // Assets fetched per-meme below rather than in one inArray query above --
    // this endpoint is a low-traffic "my posts" view, not the hot feed path,
    // so simplicity wins over the batching feed-memes.routes.ts does.
    const results = await Promise.all(
      rows.map(async (m) => {
        const assets = await db.select().from(memeAssets).where(eq(memeAssets.memeId, m.id))
        return {
          id: m.id,
          post_type: m.postType,
          caption: m.caption,
          status: m.status,
          created_at: m.createdAt,
          assets: assets
            .sort((a, b) => a.position - b.position)
            .map((a) => ({ id: a.id, asset_type: a.assetType, position: a.position, s3_url: a.s3Url })),
        }
      })
    )

    return res.json({ memes: results })
  } catch (error) {
    console.error('List my memes error:', error)
    return res.status(500).json({ error: 'Failed to load your memes' })
  }
})

export default router
