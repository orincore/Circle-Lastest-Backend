import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { requireAdmin, AdminRequest, logAdminAction } from '../middleware/adminAuth.js'
import { and, desc, eq, or, isNull, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { announcements, profiles } from '../db/schema.js'
import { NotificationService } from '../services/notificationService.js'

const router = Router()

// List announcements
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { active, placement, limit = '100' } = req.query as any
    const lim = Math.min(parseInt(limit || '100'), 500)

    const conditions = []
    if (active === 'true') conditions.push(eq(announcements.isActive, true))
    if (placement) {
      conditions.push(
        or(
          isNull(announcements.placements),
          sql`${announcements.placements} @> ARRAY[${placement}]::text[]`
        )
      )
    }

    const rows = await db.select()
      .from(announcements)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(announcements.priority), desc(announcements.publishedAt), desc(announcements.createdAt))
      .limit(lim)

    const data = rows.map(r => ({
      id: r.id,
      title: r.title,
      message: r.message,
      image_url: r.imageUrl,
      link_url: r.linkUrl,
      buttons: r.buttons,
      placements: r.placements,
      audience: r.audience,
      countries: r.countries,
      min_app_version: r.minAppVersion,
      priority: r.priority,
      starts_at: r.startsAt,
      ends_at: r.endsAt,
      is_active: r.isActive,
      send_push_on_publish: r.sendPushOnPublish,
      created_by: r.createdBy,
      created_at: r.createdAt,
      updated_at: r.updatedAt,
      published_at: r.publishedAt,
    }))

    return res.json({ announcements: data })
  } catch (e) {
    return res.status(500).json({ error: 'Failed to list announcements' })
  }
})

// Create announcement
router.post('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      title,
      message,
      imageUrl,
      linkUrl,
      buttons,
      placements,
      audience = 'all',
      countries,
      minAppVersion,
      priority = 0,
      startsAt,
      endsAt,
      isActive = true,
      sendPushOnPublish = false,
    } = req.body || {}

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' })
    }

    const insert = {
      title: title || null,
      message,
      imageUrl: imageUrl || null,
      linkUrl: linkUrl || null,
      buttons: Array.isArray(buttons) ? buttons : null,
      placements: Array.isArray(placements) ? placements : null,
      audience: audience || 'all',
      countries: Array.isArray(countries) ? countries : null,
      minAppVersion: minAppVersion || null,
      priority: Number.isFinite(priority) ? priority : 0,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      isActive: !!isActive,
      sendPushOnPublish: !!sendPushOnPublish,
      createdBy: req.user!.id,
    }

    const [row] = await db.insert(announcements).values(insert).returning()

    if (!row) {
      console.error('Create announcement error: no row returned')
      return res.status(500).json({ error: 'Failed to create announcement' })
    }

    const data = {
      id: row.id,
      title: row.title,
      message: row.message,
      image_url: row.imageUrl,
      link_url: row.linkUrl,
      buttons: row.buttons,
      placements: row.placements,
      audience: row.audience,
      countries: row.countries,
      min_app_version: row.minAppVersion,
      priority: row.priority,
      starts_at: row.startsAt,
      ends_at: row.endsAt,
      is_active: row.isActive,
      send_push_on_publish: row.sendPushOnPublish,
      created_by: row.createdBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      published_at: row.publishedAt,
    }

    await logAdminAction(req.user!.id, 'announcement_create', 'announcements', data.id, insert)

    return res.json({ announcement: data })
  } catch (e) {
    console.error('admin announcements create error:', e)
    return res.status(500).json({ error: 'Failed to create announcement' })
  }
})

// Update announcement
router.put('/:id', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { id } = req.params
    const payload = req.body || {}

    const update: any = {
      title: 'title' in payload ? payload.title : undefined,
      message: 'message' in payload ? payload.message : undefined,
      imageUrl: 'imageUrl' in payload ? payload.imageUrl : undefined,
      linkUrl: 'linkUrl' in payload ? payload.linkUrl : undefined,
      buttons: 'buttons' in payload ? (Array.isArray(payload.buttons) ? payload.buttons : null) : undefined,
      placements: 'placements' in payload ? (Array.isArray(payload.placements) ? payload.placements : null) : undefined,
      audience: 'audience' in payload ? payload.audience : undefined,
      countries: 'countries' in payload ? (Array.isArray(payload.countries) ? payload.countries : null) : undefined,
      minAppVersion: 'minAppVersion' in payload ? payload.minAppVersion : undefined,
      priority: 'priority' in payload ? payload.priority : undefined,
      startsAt: 'startsAt' in payload ? payload.startsAt : undefined,
      endsAt: 'endsAt' in payload ? payload.endsAt : undefined,
      isActive: 'isActive' in payload ? !!payload.isActive : undefined,
      sendPushOnPublish: 'sendPushOnPublish' in payload ? !!payload.sendPushOnPublish : undefined,
      updatedAt: new Date().toISOString(),
    }

    const [row] = await db.update(announcements).set(update).where(eq(announcements.id, id)).returning()

    if (!row) {
      console.error('Update announcement error: not found')
      return res.status(500).json({ error: 'Failed to update announcement' })
    }

    const data = {
      id: row.id,
      title: row.title,
      message: row.message,
      image_url: row.imageUrl,
      link_url: row.linkUrl,
      buttons: row.buttons,
      placements: row.placements,
      audience: row.audience,
      countries: row.countries,
      min_app_version: row.minAppVersion,
      priority: row.priority,
      starts_at: row.startsAt,
      ends_at: row.endsAt,
      is_active: row.isActive,
      send_push_on_publish: row.sendPushOnPublish,
      created_by: row.createdBy,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      published_at: row.publishedAt,
    }

    await logAdminAction(req.user!.id, 'announcement_update', 'announcements', id, update)

    return res.json({ announcement: data })
  } catch (e) {
    console.error('admin announcements update error:', e)
    return res.status(500).json({ error: 'Failed to update announcement' })
  }
})

// Publish announcement (optionally send push)
router.patch('/:id/publish', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { id } = req.params
    const { sendPush } = req.body || {}

    const [announcement] = await db.select().from(announcements).where(eq(announcements.id, id)).limit(1)

    if (!announcement) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    const [updated] = await db.update(announcements).set({
      isActive: true,
      publishedAt: new Date().toISOString(),
    }).where(eq(announcements.id, id)).returning()

    if (!updated) {
      console.error('Publish announcement error: update failed')
      return res.status(500).json({ error: 'Failed to publish announcement' })
    }

    await logAdminAction(req.user!.id, 'announcement_publish', 'announcements', id, { sendPush })

    // Optionally push notify audience
    if (sendPush || announcement.sendPushOnPublish) {
      // Minimal audience selection: send to last 5k active users to avoid heavy broadcast
      const users = await db.select({ id: profiles.id }).from(profiles).orderBy(desc(profiles.lastSeen)).limit(5000)

      const title = announcement.title || 'Announcement'
      const message = announcement.message
      const dataPayload: Record<string, any> = {
        action: 'announcement',
        announcement_id: announcement.id,
        link_url: announcement.linkUrl || undefined,
        placements: announcement.placements || undefined,
      }

      if (Array.isArray(users)) {
        for (const u of users) {
          try {
            await NotificationService.createNotification({
              recipient_id: u.id,
              type: 'profile_suggestion', // reuse generic type for now
              title,
              message,
              data: dataPayload,
            })
          } catch {}
        }
      }
    }

    const updatedData = {
      id: updated.id,
      title: updated.title,
      message: updated.message,
      image_url: updated.imageUrl,
      link_url: updated.linkUrl,
      buttons: updated.buttons,
      placements: updated.placements,
      audience: updated.audience,
      countries: updated.countries,
      min_app_version: updated.minAppVersion,
      priority: updated.priority,
      starts_at: updated.startsAt,
      ends_at: updated.endsAt,
      is_active: updated.isActive,
      send_push_on_publish: updated.sendPushOnPublish,
      created_by: updated.createdBy,
      created_at: updated.createdAt,
      updated_at: updated.updatedAt,
      published_at: updated.publishedAt,
    }

    return res.json({ announcement: updatedData, published: true })
  } catch (e) {
    console.error('admin announcements publish error:', e)
    return res.status(500).json({ error: 'Failed to publish announcement' })
  }
})

// Delete announcement
router.delete('/:id', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { id } = req.params

    await db.delete(announcements).where(eq(announcements.id, id))

    await logAdminAction(req.user!.id, 'announcement_delete', 'announcements', id, {})

    return res.json({ success: true })
  } catch (e) {
    console.error('admin announcements delete error:', e)
    return res.status(500).json({ error: 'Failed to delete announcement' })
  }
})

export default router
