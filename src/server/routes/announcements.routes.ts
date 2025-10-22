import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import { verifyJwt } from '../utils/jwt.js'

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

    // Try to enrich country/audience from authenticated user if available
    try {
      const rawAuth = req.headers.authorization?.toString()
      const token = rawAuth?.startsWith('Bearer ') ? rawAuth.slice(7) : undefined
      if (token) {
        const payload = verifyJwt<any>(token)
        const userId = payload?.sub
        if (userId) {
          const { data: profile } = await supabase
            .from('profiles')
            .select('id, country, subscription_tier')
            .eq('id', userId)
            .maybeSingle()
          if (!country && profile?.country) country = String(profile.country).toUpperCase()
          if (!audience && profile?.subscription_tier) {
            // Map tiers to audience buckets
            audience = ['plus','premium','paid'].includes(String(profile.subscription_tier).toLowerCase()) ? 'paid' : 'free'
          }
        }
      }
    } catch {}

    // Base: active + within schedule window
    let query = supabase
      .from('announcements')
      .select('*')
      .eq('is_active', true)
      .or('starts_at.is.null,starts_at.lte.' + new Date().toISOString())
      .or('ends_at.is.null,ends_at.gte.' + new Date().toISOString())
      .order('priority', { ascending: false })
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })

    // Filter by placement if provided (row has placements text[] or null for all)
    if (placement) {
      // Supabase does not support array contains in JS client without RPC; emulate: include rows where placements is null OR placements contains placement
      query = query.or(`placements.is.null,placements.cs.{${placement}}`)
    }
    // Audience: allow rows with audience null/'all' or matching requested audience
    if (audience) {
      const a = audience.toLowerCase()
      query = query.or(`audience.is.null,audience.eq.all,audience.eq.${a}`)
    }

    // Countries: include rows where countries is null OR contains the requester's country
    if (country) {
      query = query.or(`countries.is.null,countries.cs.{${country}}`)
    }

    const { data, error } = await query

    if (error) {
      console.error('Error fetching announcements:', error)
      return res.status(500).json({ error: 'Failed to fetch announcements' })
    }

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

    const filteredByVersion = (data || []).filter((row: any) => {
      if (!row.min_app_version || !appVersion) return true
      return cmp(String(appVersion), String(row.min_app_version)) >= 0
    })

    const announcements = filteredByVersion.map((row: any) => ({
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

    return res.json({ announcements })
  } catch (e) {
    console.error('Announcements /active error:', e)
    return res.status(500).json({ error: 'Failed to fetch announcements' })
  }
})

export default router
