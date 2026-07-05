import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { and, count, desc, eq, gte } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles, userActivityEvents } from '../db/schema.js'
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
      userId,
      eventName: event.event_name,
      sessionId: event.session_id,
      properties: event.properties || {},
      createdAt: event.timestamp || new Date().toISOString(),
    }))

    // Insert events in batch
    try {
      await db.insert(userActivityEvents).values(eventsToInsert)
    } catch (error) {
      console.error('Error inserting analytics events:', error)
      return res.status(500).json({ error: 'Failed to track events' })
    }

    // Update user's last_active timestamp
    await db.update(profiles).set({ lastActive: new Date().toISOString() }).where(eq(profiles.id, userId))

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
    const events = await db.select({ event_name: userActivityEvents.eventName, created_at: userActivityEvents.createdAt })
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.userId, userId), gte(userActivityEvents.createdAt, startDate.toISOString())))

    // Count events by type
    const eventCounts: Record<string, number> = {}
    events?.forEach(event => {
      eventCounts[event.event_name] = (eventCounts[event.event_name] || 0) + 1
    })

    // Get session data
    const sessions = await db.select({
      session_id: userActivityEvents.sessionId,
      created_at: userActivityEvents.createdAt,
      properties: userActivityEvents.properties,
    })
      .from(userActivityEvents)
      .where(and(
        eq(userActivityEvents.userId, userId),
        eq(userActivityEvents.eventName, 'session_start'),
        gte(userActivityEvents.createdAt, startDate.toISOString()),
      ))

    const totalSessions = sessions?.length || 0

    // Calculate average session duration
    const sessionEnds = await db.select({ properties: userActivityEvents.properties })
      .from(userActivityEvents)
      .where(and(
        eq(userActivityEvents.userId, userId),
        eq(userActivityEvents.eventName, 'session_end'),
        gte(userActivityEvents.createdAt, startDate.toISOString()),
      ))

    const avgSessionDuration = sessionEnds?.length
      ? sessionEnds.reduce((sum, s) => sum + ((s.properties as any)?.duration_seconds || 0), 0) / sessionEnds.length
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
    const limitNum = parseInt(limit as string)
    const offsetNum = parseInt(offset as string)

    const [{ count: total }] = await db.select({ count: count() }).from(userActivityEvents).where(eq(userActivityEvents.userId, userId))

    const events = await db.select()
      .from(userActivityEvents)
      .where(eq(userActivityEvents.userId, userId))
      .orderBy(desc(userActivityEvents.createdAt))
      .limit(limitNum)
      .offset(offsetNum)

    return res.json({
      events: events || [],
      total: total || 0,
      limit: limitNum,
      offset: offsetNum,
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

    const features = await db.select({ properties: userActivityEvents.properties })
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.eventName, 'feature_usage'), gte(userActivityEvents.createdAt, startDate.toISOString())))

    const featureCounts: Record<string, number> = {}
    features?.forEach(event => {
      const feature = (event.properties as any)?.feature
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
    const dailyActivity = await db.select({ user_id: userActivityEvents.userId, created_at: userActivityEvents.createdAt })
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.eventName, 'session_start'), gte(userActivityEvents.createdAt, startDate.toISOString())))

    const dailyActiveUsers: Record<string, Set<string>> = {}
    dailyActivity?.forEach(event => {
      const date = new Date(event.created_at as string).toISOString().split('T')[0]
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

    const screenViews = await db.select({ properties: userActivityEvents.properties, created_at: userActivityEvents.createdAt })
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.eventName, 'screen_view'), gte(userActivityEvents.createdAt, startDate.toISOString())))

    const screenCounts: Record<string, number> = {}
    const screenTime: Record<string, number[]> = {}

    screenViews?.forEach(event => {
      const screen = (event.properties as any)?.screen_name
      if (screen) {
        screenCounts[screen] = (screenCounts[screen] || 0) + 1
      }
    })

    // Get time spent on screens
    const timeData = await db.select({ properties: userActivityEvents.properties })
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.eventName, 'time_on_screen'), gte(userActivityEvents.createdAt, startDate.toISOString())))

    timeData?.forEach(event => {
      const screen = (event.properties as any)?.screen_name
      const duration = (event.properties as any)?.duration_seconds
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

/**
 * Get events by type
 * GET /api/analytics/events/:eventType
 */
router.get('/events/:eventType', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { eventType } = req.params
    const { days = '7', limit = '100' } = req.query
    const numDays = parseInt(days as string)
    const limitNum = parseInt(limit as string)

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    const [{ count: total }] = await db.select({ count: count() })
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.eventName, eventType), gte(userActivityEvents.createdAt, startDate.toISOString())))

    const events = await db.select()
      .from(userActivityEvents)
      .where(and(eq(userActivityEvents.eventName, eventType), gte(userActivityEvents.createdAt, startDate.toISOString())))
      .orderBy(desc(userActivityEvents.createdAt))
      .limit(limitNum)

    // Aggregate by properties if needed
    const aggregated: Record<string, any> = {}
    events?.forEach(event => {
      const key = JSON.stringify(event.properties)
      if (!aggregated[key]) {
        aggregated[key] = {
          properties: event.properties,
          count: 0,
          users: new Set(),
        }
      }
      aggregated[key].count++
      aggregated[key].users.add(event.userId)
    })

    const results = Object.values(aggregated).map((item: any) => ({
      ...item.properties,
      count: item.count,
      uniqueUsers: item.users.size,
    }))

    return res.json({
      eventType,
      totalEvents: total || 0,
      results: results.sort((a, b) => b.count - a.count),
    })
  } catch (error) {
    console.error('Events by type error:', error)
    return res.status(500).json({ error: 'Failed to fetch events' })
  }
})

/**
 * Get all event types summary
 * GET /api/analytics/events-summary
 */
router.get('/events-summary', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { days = '7' } = req.query
    const numDays = parseInt(days as string)

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    // Get counts for each event type
    const events = await db.select({
      event_name: userActivityEvents.eventName,
      user_id: userActivityEvents.userId,
      created_at: userActivityEvents.createdAt,
    })
      .from(userActivityEvents)
      .where(gte(userActivityEvents.createdAt, startDate.toISOString()))

    const eventSummary: Record<string, { count: number; users: Set<string> }> = {}

    events?.forEach(event => {
      if (!eventSummary[event.event_name]) {
        eventSummary[event.event_name] = {
          count: 0,
          users: new Set(),
        }
      }
      eventSummary[event.event_name].count++
      eventSummary[event.event_name].users.add(event.user_id)
    })

    const summary = Object.entries(eventSummary).map(([eventName, data]) => ({
      eventName,
      totalEvents: data.count,
      uniqueUsers: data.users.size,
    })).sort((a, b) => b.totalEvents - a.totalEvents)

    return res.json({ summary })
  } catch (error) {
    console.error('Events summary error:', error)
    return res.status(500).json({ error: 'Failed to fetch events summary' })
  }
})

export default router
