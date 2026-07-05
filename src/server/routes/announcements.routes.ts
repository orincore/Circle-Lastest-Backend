import { Router } from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { announcements } from '../db/schema.js'

const router = Router()

/**
 * GET /api/announcements/active
 * Optional query params:
 *  - placement: string (e.g., 'match', 'explore', 'global')
 */
router.get('/active', async (req, res) => {
  try {
    const placement = (req.query.placement as string | undefined)?.trim()
    let audience = (req.query.audience as string | undefined)?.trim()
    let country = (req.query.country as string | undefined)?.trim()?.toUpperCase()
    const appVersion = (req.query.appVersion as string | undefined)?.trim()
    const debug = String(req.query.debug || '').toLowerCase() === 'true'
    // Note: Skipping auth enrichment to avoid dependency; rely on explicit query params or global defaults

    // Base: active (we'll do schedule + placement + audience filters in JS to avoid .or overrides)
    const rows = await db.select({
      id: announcements.id,
      title: announcements.title,
      message: announcements.message,
      image_url: announcements.imageUrl,
      link_url: announcements.linkUrl,
      buttons: announcements.buttons,
      placements: announcements.placements,
      audience: announcements.audience,
      countries: announcements.countries,
      min_app_version: announcements.minAppVersion,
      priority: announcements.priority,
      starts_at: announcements.startsAt,
      ends_at: announcements.endsAt,
      is_active: announcements.isActive,
      send_push_on_publish: announcements.sendPushOnPublish,
      created_at: announcements.createdAt,
      updated_at: announcements.updatedAt,
      published_at: announcements.publishedAt,
    })
      .from(announcements)
      .where(eq(announcements.isActive, true))
      .orderBy(desc(announcements.priority), desc(announcements.publishedAt), desc(announcements.createdAt))

    const data = rows

    // Note: placement, audience, country, time-window filtering are done below

    // Optional semver comparison for min_app_version
    const cmp = (a?: string, b?: string) => {
      if (!a || !b) return 0
      const pa = a.split('.').map(n => parseInt(n, 10) || 0)
      const pb = b.split('.').map(n => parseInt(n, 10) || 0)
      const len = Math.max(pa.length, pb.length)
      for (let i = 0; i < len; i++) {
        const da = pa[i] || 0, db = pb[i] || 0
        if (da > db) return 1
        if (da < db) return -1
      }
      return 0
    }

    const nowMs = Date.now()

    if (debug) {
      const announcementsOut = (data || []).map((row: any) => ({
        id: row.id,
        title: row.title || undefined,
        message: row.message,
        imageUrl: row.image_url || undefined,
        linkUrl: row.link_url || undefined,
        buttons: Array.isArray(row.buttons) ? row.buttons : undefined,
        startsAt: row.starts_at || undefined,
        endsAt: row.ends_at || undefined,
        priority: row.priority ?? 0,
        audience: row.audience || 'all',
        sendPush: !!row.send_push_on_publish,
      }))
      return res.json({ announcements: announcementsOut })
    }

    const filteredByVersion = (data || []).filter((row: any) => {
      if (!row.min_app_version || !appVersion) return true
      return cmp(String(appVersion), String(row.min_app_version)) >= 0
    })

    // Schedule window filter
    const filteredBySchedule = filteredByVersion.filter((row: any) => {
      const s = row.starts_at ? Date.parse(row.starts_at) : null
      const e = row.ends_at ? Date.parse(row.ends_at) : null
      if (s && nowMs < s) return false
      if (e && nowMs > e) return false
      return true
    })

    // Placement filter
    const filteredByPlacement = filteredBySchedule.filter((row: any) => {
      if (!placement) return true
      const arr: string[] | null = Array.isArray(row.placements) ? row.placements : null
      if (!arr || arr.length === 0) return true // global
      return arr.includes(placement)
    })

    // Audience filter
    const filteredByAudience = filteredByPlacement.filter((row: any) => {
      if (!row.audience || row.audience === 'all') return true
      if (!audience) return true
      return String(row.audience).toLowerCase() === String(audience).toLowerCase()
    })

    // Country filter
    const filteredByCountry = filteredByAudience.filter((row: any) => {
      if (!country) return true
      const arr: string[] | null = Array.isArray(row.countries) ? row.countries : null
      if (!arr || arr.length === 0) return true
      return arr.map(c => String(c).toUpperCase()).includes(String(country).toUpperCase())
    })

    const announcementsOut = filteredByCountry.map((row: any) => ({
      id: row.id,
      title: row.title || undefined,
      message: row.message,
      imageUrl: row.image_url || undefined,
      linkUrl: row.link_url || undefined,
      buttons: Array.isArray(row.buttons) ? row.buttons : undefined,
      startsAt: row.starts_at || undefined,
      endsAt: row.ends_at || undefined,
      priority: row.priority ?? 0,
      audience: row.audience || 'all',
      sendPush: !!row.send_push_on_publish,
    }))

    return res.json({ announcements: announcementsOut })
  } catch (e) {
    console.error('Announcements /active error:', e)
    return res.status(500).json({ error: 'Failed to fetch announcements' })
  }
})

export default router
