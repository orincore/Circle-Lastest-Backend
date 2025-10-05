import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import type { AuthRequest } from '../middleware/auth.js'

const router = Router()

/**
 * Track user events
 * POST /api/analytics/track
 */
router.post('/track', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { events } = req.body
    const userId = req.user!.id

    if (!events || !Array.isArray(events)) {
      return res.status(400).json({ error: 'Events array is required' })
    }

    // Prepare events for insertion
    const eventsToInsert = events.map(event => ({
      user_id: userId,
      event_name: event.event_name,
      session_id: event.session_id,
      properties: event.properties || {},
      created_at: event.timestamp || new Date().toISOString(),
    }))

    // Insert events in batch
    const { error } = await supabase
      .from('user_activity_events')
      .insert(eventsToInsert)

    if (error) {
      console.error('Error inserting analytics events:', error)
      return res.status(500).json({ error: 'Failed to track events' })
    }

    // Update user's last_active timestamp
    await supabase
      .from('profiles')
      .update({ last_active: new Date().toISOString() })
      .eq('id', userId)

    return res.json({ 
      success: true, 
      tracked: events.length 
    })
  } catch (error) {
    console.error('Track events error:', error)
    return res.status(500).json({ error: 'Failed to track events' })
  }
})

/**
 * Get user activity summary
 * GET /api/analytics/user/:userId/summary
 */
router.get('/user/:userId/summary', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const { days = '30' } = req.query
    const numDays = parseInt(days as string)

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    // Get event counts by type
    const { data: events } = await supabase
      .from('user_activity_events')
      .select('event_name, created_at')
      .eq('user_id', userId)
      .gte('created_at', startDate.toISOString())

    // Count events by type
    const eventCounts: Record<string, number> = {}
    events?.forEach(event => {
      eventCounts[event.event_name] = (eventCounts[event.event_name] || 0) + 1
    })

    // Get session data
    const { data: sessions } = await supabase
      .from('user_activity_events')
      .select('session_id, created_at, properties')
      .eq('user_id', userId)
      .eq('event_name', 'session_start')
      .gte('created_at', startDate.toISOString())

    const totalSessions = sessions?.length || 0

    // Calculate average session duration
    const { data: sessionEnds } = await supabase
      .from('user_activity_events')
      .select('properties')
      .eq('user_id', userId)
      .eq('event_name', 'session_end')
      .gte('created_at', startDate.toISOString())

    const avgSessionDuration = sessionEnds?.length 
      ? sessionEnds.reduce((sum, s) => sum + (s.properties?.duration_seconds || 0), 0) / sessionEnds.length
      : 0

    return res.json({
      userId,
      timeRange: numDays,
      totalEvents: events?.length || 0,
      eventCounts,
      totalSessions,
      avgSessionDuration: Math.round(avgSessionDuration),
    })
  } catch (error) {
    console.error('User summary error:', error)
    return res.status(500).json({ error: 'Failed to fetch user summary' })
  }
})

/**
 * Get user activity timeline
 * GET /api/analytics/user/:userId/timeline
 */
router.get('/user/:userId/timeline', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const { limit = '50', offset = '0' } = req.query

    const { data: events, count } = await supabase
      .from('user_activity_events')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1)

    return res.json({
      events: events || [],
      total: count || 0,
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
    })
  } catch (error) {
    console.error('Timeline error:', error)
    return res.status(500).json({ error: 'Failed to fetch timeline' })
  }
})

/**
 * Get popular features
 * GET /api/analytics/features/popular
 */
router.get('/features/popular', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { days = '7' } = req.query
    const numDays = parseInt(days as string)

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    const { data: features } = await supabase
      .from('user_activity_events')
      .select('properties')
      .eq('event_name', 'feature_usage')
      .gte('created_at', startDate.toISOString())

    const featureCounts: Record<string, number> = {}
    features?.forEach(event => {
      const feature = event.properties?.feature
      if (feature) {
        featureCounts[feature] = (featureCounts[feature] || 0) + 1
      }
    })

    const popularFeatures = Object.entries(featureCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([feature, count]) => ({ feature, count }))

    return res.json({ popularFeatures })
  } catch (error) {
    console.error('Popular features error:', error)
    return res.status(500).json({ error: 'Failed to fetch popular features' })
  }
})

/**
 * Get user engagement metrics
 * GET /api/analytics/engagement
 */
router.get('/engagement', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { days = '7' } = req.query
    const numDays = parseInt(days as string)

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    // Daily active users
    const { data: dailyActivity } = await supabase
      .from('user_activity_events')
      .select('user_id, created_at')
      .eq('event_name', 'session_start')
      .gte('created_at', startDate.toISOString())

    const dailyActiveUsers: Record<string, Set<string>> = {}
    dailyActivity?.forEach(event => {
      const date = new Date(event.created_at).toISOString().split('T')[0]
      if (!dailyActiveUsers[date]) {
        dailyActiveUsers[date] = new Set()
      }
      dailyActiveUsers[date].add(event.user_id)
    })

    const engagementData = Object.entries(dailyActiveUsers).map(([date, users]) => ({
      date,
      activeUsers: users.size,
    }))

    return res.json({ data: engagementData })
  } catch (error) {
    console.error('Engagement error:', error)
    return res.status(500).json({ error: 'Failed to fetch engagement data' })
  }
})

/**
 * Get screen analytics
 * GET /api/analytics/screens
 */
router.get('/screens', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { days = '7' } = req.query
    const numDays = parseInt(days as string)

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    const { data: screenViews } = await supabase
      .from('user_activity_events')
      .select('properties, created_at')
      .eq('event_name', 'screen_view')
      .gte('created_at', startDate.toISOString())

    const screenCounts: Record<string, number> = {}
    const screenTime: Record<string, number[]> = {}

    screenViews?.forEach(event => {
      const screen = event.properties?.screen_name
      if (screen) {
        screenCounts[screen] = (screenCounts[screen] || 0) + 1
      }
    })

    // Get time spent on screens
    const { data: timeData } = await supabase
      .from('user_activity_events')
      .select('properties')
      .eq('event_name', 'time_on_screen')
      .gte('created_at', startDate.toISOString())

    timeData?.forEach(event => {
      const screen = event.properties?.screen_name
      const duration = event.properties?.duration_seconds
      if (screen && duration) {
        if (!screenTime[screen]) {
          screenTime[screen] = []
        }
        screenTime[screen].push(duration)
      }
    })

    const screenAnalytics = Object.entries(screenCounts).map(([screen, views]) => ({
      screen,
      views,
      avgTimeSeconds: screenTime[screen]
        ? Math.round(screenTime[screen].reduce((a, b) => a + b, 0) / screenTime[screen].length)
        : 0,
    }))

    return res.json({ 
      screens: screenAnalytics.sort((a, b) => b.views - a.views) 
    })
  } catch (error) {
    console.error('Screen analytics error:', error)
    return res.status(500).json({ error: 'Failed to fetch screen analytics' })
  }
})

export default router
