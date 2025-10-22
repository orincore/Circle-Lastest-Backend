import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { requireAdmin, AdminRequest, logAdminAction } from '../middleware/adminAuth.js'
import { supabase } from '../config/supabase.js'
import { NotificationService } from '../services/notificationService.js'

const router = Router()

// List announcements
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { active, placement, limit = '100' } = req.query as any
    const lim = Math.min(parseInt(limit || '100'), 500)

    let query = supabase
      .from('announcements')
      .select('*')
      .order('priority', { ascending: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(lim)

    if (active === 'true') query = query.eq('is_active', true)
    if (placement) query = query.or(`placements.is.null,placements.cs.{${placement}}`)

    const { data, error } = await query
    if (error) return res.status(500).json({ error: 'Failed to list announcements' })
    return res.json({ announcements: data || [] })
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
      image_url: imageUrl || null,
      link_url: linkUrl || null,
      buttons: Array.isArray(buttons) ? buttons : null,
      placements: Array.isArray(placements) ? placements : null,
      audience: audience || 'all',
      countries: Array.isArray(countries) ? countries : null,
      min_app_version: minAppVersion || null,
      priority: Number.isFinite(priority) ? priority : 0,
      starts_at: startsAt || null,
      ends_at: endsAt || null,
      is_active: !!isActive,
      send_push_on_publish: !!sendPushOnPublish,
      created_by: req.user!.id,
    }

    const { data, error } = await supabase
      .from('announcements')
      .insert(insert)
      .select('*')
      .single()

    if (error) {
      console.error('Create announcement error:', error)
      return res.status(500).json({ error: 'Failed to create announcement' })
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
      image_url: 'imageUrl' in payload ? payload.imageUrl : undefined,
      link_url: 'linkUrl' in payload ? payload.linkUrl : undefined,
      buttons: 'buttons' in payload ? (Array.isArray(payload.buttons) ? payload.buttons : null) : undefined,
      placements: 'placements' in payload ? (Array.isArray(payload.placements) ? payload.placements : null) : undefined,
      audience: 'audience' in payload ? payload.audience : undefined,
      countries: 'countries' in payload ? (Array.isArray(payload.countries) ? payload.countries : null) : undefined,
      min_app_version: 'minAppVersion' in payload ? payload.minAppVersion : undefined,
      priority: 'priority' in payload ? payload.priority : undefined,
      starts_at: 'startsAt' in payload ? payload.startsAt : undefined,
      ends_at: 'endsAt' in payload ? payload.endsAt : undefined,
      is_active: 'isActive' in payload ? !!payload.isActive : undefined,
      send_push_on_publish: 'sendPushOnPublish' in payload ? !!payload.sendPushOnPublish : undefined,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('announcements')
      .update(update)
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      console.error('Update announcement error:', error)
      return res.status(500).json({ error: 'Failed to update announcement' })
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

    const { data: announcement, error: fetchErr } = await supabase
      .from('announcements')
      .select('*')
      .eq('id', id)
      .maybeSingle()

    if (fetchErr || !announcement) {
      return res.status(404).json({ error: 'Announcement not found' })
    }

    const { data: updated, error } = await supabase
      .from('announcements')
      .update({ is_active: true, published_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .single()

    if (error) {
      console.error('Publish announcement error:', error)
      return res.status(500).json({ error: 'Failed to publish announcement' })
    }

    await logAdminAction(req.user!.id, 'announcement_publish', 'announcements', id, { sendPush })

    // Optionally push notify audience
    if (sendPush || announcement.send_push_on_publish) {
      // Minimal audience selection: send to last 5k active users to avoid heavy broadcast
      const { data: users } = await supabase
        .from('profiles')
        .select('id')
        .order('last_seen', { ascending: false })
        .limit(5000)

      const title = announcement.title || 'Announcement'
      const message = announcement.message
      const dataPayload: Record<string, any> = {
        action: 'announcement',
        announcement_id: announcement.id,
        link_url: announcement.link_url || undefined,
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

    return res.json({ announcement: updated, published: true })
  } catch (e) {
    console.error('admin announcements publish error:', e)
    return res.status(500).json({ error: 'Failed to publish announcement' })
  }
})

// Delete announcement
router.delete('/:id', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { id } = req.params

    const { error } = await supabase
      .from('announcements')
      .delete()
      .eq('id', id)

    if (error) {
      console.error('Delete announcement error:', error)
      return res.status(500).json({ error: 'Failed to delete announcement' })
    }

    await logAdminAction(req.user!.id, 'announcement_delete', 'announcements', id, {})

    return res.json({ success: true })
  } catch (e) {
    console.error('admin announcements delete error:', e)
    return res.status(500).json({ error: 'Failed to delete announcement' })
  }
})

export default router
