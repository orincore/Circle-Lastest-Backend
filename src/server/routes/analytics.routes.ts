import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { and, gte, isNotNull } from 'drizzle-orm'
import { db } from '../config/db.js'
import { analyticsEvents, appVersions, crashReports } from '../db/schema.js'

const router = Router()

// Rate limiting for analytics
const analyticsLimit = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Allow more frequent analytics calls
  message: {
    error: 'Too many analytics requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
})

// Validation schemas
const analyticsEventSchema = z.object({
  event_name: z.string().min(1).max(100),
  user_id: z.string().optional(),
  session_id: z.string().optional(),
  timestamp: z.string(),
  properties: z.record(z.any()).optional(),
})

const analyticsTrackSchema = z.object({
  events: z.array(analyticsEventSchema).min(1).max(50),
})

const appVersionSchema = z.object({
  version: z.string(),
  buildNumber: z.union([z.string(), z.number()]),
  platform: z.string(),
  timestamp: z.string(),
  expoVersion: z.string().optional(),
  deviceId: z.string().optional(),
})

const crashReportSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  isFatal: z.boolean(),
  userId: z.string().optional(),
  sessionId: z.string().optional(),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().optional(),
  }),
  device: z.object({
    platform: z.string(),
    version: z.union([z.string(), z.number()]),
    model: z.string().optional(),
    appVersion: z.string(),
    buildNumber: z.union([z.string(), z.number()]),
  }),
  app: z.object({
    isDevice: z.boolean().optional(),
    expoVersion: z.string().optional(),
  }).optional(),
})

/**
 * Track analytics events
 * POST /api/analytics/track
 */
router.post('/track', analyticsLimit, async (req, res) => {
  try {
    const parse = analyticsTrackSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ 
        error: 'Invalid analytics data', 
        details: parse.error.flatten() 
      })
    }

    const { events } = parse.data

    // Store events in database
    const analyticsData = events.map(event => ({
      eventName: event.event_name,
      userId: event.user_id,
      sessionId: event.session_id,
      timestamp: event.timestamp,
      properties: event.properties || {},
      createdAt: new Date().toISOString(),
    }))

    try {
      await db.insert(analyticsEvents).values(analyticsData)
    } catch (error) {
      console.error('Analytics storage error:', error)
      return res.status(500).json({ error: 'Failed to store analytics data' })
    }

    //console.log(`📊 Stored ${events.length} analytics events`)

    return res.json({
      success: true,
      message: `Tracked ${events.length} events`,
    })
  } catch (error) {
    console.error('Analytics tracking error:', error)
    return res.status(500).json({ error: 'Failed to track analytics' })
  }
})

/**
 * Track app version
 * POST /api/analytics/app-version
 */
router.post('/app-version', analyticsLimit, async (req, res) => {
  try {
    const parse = appVersionSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ 
        error: 'Invalid version data', 
        details: parse.error.flatten() 
      })
    }

    const versionData = parse.data

    // Store version info
    try {
      await db.insert(appVersions).values({
        version: versionData.version,
        buildNumber: versionData.buildNumber.toString(),
        platform: versionData.platform,
        expoVersion: versionData.expoVersion,
        deviceId: versionData.deviceId,
        timestamp: versionData.timestamp,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error('Version tracking error:', error)
      return res.status(500).json({ error: 'Failed to store version data' })
    }

    //console.log(`📱 Tracked app version: ${versionData.version} (${versionData.platform})`)

    return res.json({
      success: true,
      message: 'Version tracked successfully',
    })
  } catch (error) {
    console.error('Version tracking error:', error)
    return res.status(500).json({ error: 'Failed to track version' })
  }
})

/**
 * Report crash
 * POST /api/analytics/crash-report
 */
router.post('/crash-report', async (req, res) => {
  try {
    const parse = crashReportSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ 
        error: 'Invalid crash report data', 
        details: parse.error.flatten() 
      })
    }

    const crashData = parse.data

    // Store crash report
    try {
      await db.insert(crashReports).values({
        crashId: crashData.id,
        timestamp: crashData.timestamp,
        type: crashData.type,
        isFatal: crashData.isFatal,
        userId: crashData.userId,
        sessionId: crashData.sessionId,
        errorName: crashData.error.name,
        errorMessage: crashData.error.message,
        errorStack: crashData.error.stack,
        devicePlatform: crashData.device.platform,
        deviceVersion: crashData.device.version.toString(),
        deviceModel: crashData.device.model,
        appVersion: crashData.device.appVersion,
        buildNumber: crashData.device.buildNumber.toString(),
        isDevice: crashData.app?.isDevice,
        expoVersion: crashData.app?.expoVersion,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      console.error('Crash report storage error:', error)
      return res.status(500).json({ error: 'Failed to store crash report' })
    }

    //console.log(`💥 Stored crash report: ${crashData.error.name} - ${crashData.error.message}`)

    return res.json({
      success: true,
      message: 'Crash report stored successfully',
    })
  } catch (error) {
    console.error('Crash reporting error:', error)
    return res.status(500).json({ error: 'Failed to report crash' })
  }
})

/**
 * Get analytics summary (for admin dashboard)
 * GET /api/analytics/summary
 */
router.get('/summary', async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    // Get event counts by type
    const eventCounts = await db.select({ event_name: analyticsEvents.eventName })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.createdAt, sevenDaysAgo)) // Last 7 days

    // Get unique users
    const uniqueUsers = await db.select({ user_id: analyticsEvents.userId })
      .from(analyticsEvents)
      .where(and(isNotNull(analyticsEvents.userId), gte(analyticsEvents.createdAt, sevenDaysAgo)))

    // Get crash counts
    const crashes = await db.select({ is_fatal: crashReports.isFatal })
      .from(crashReports)
      .where(gte(crashReports.createdAt, sevenDaysAgo))

    // Get app versions
    const versions = await db.select({ version: appVersions.version, platform: appVersions.platform })
      .from(appVersions)
      .where(gte(appVersions.createdAt, sevenDaysAgo))

    // Process data
    const eventSummary: Record<string, number> = eventCounts?.reduce((acc: Record<string, number>, event) => {
      acc[event.event_name] = (acc[event.event_name] || 0) + 1
      return acc
    }, {} as Record<string, number>) || {}

    const uniqueUserCount = new Set(uniqueUsers?.map(u => u.user_id)).size || 0
    const totalCrashes = crashes?.length || 0
    const fatalCrashes = crashes?.filter(c => c.is_fatal).length || 0

    const versionSummary: Record<string, number> = versions?.reduce((acc: Record<string, number>, version) => {
      const key = `${version.version} (${version.platform})`
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {} as Record<string, number>) || {}

    return res.json({
      success: true,
      data: {
        events: eventSummary,
        uniqueUsers: uniqueUserCount,
        crashes: {
          total: totalCrashes,
          fatal: fatalCrashes,
        },
        versions: versionSummary,
        period: 'Last 7 days',
      },
    })
  } catch (error) {
    console.error('Analytics summary error:', error)
    return res.status(500).json({ error: 'Failed to get analytics summary' })
  }
})

export default router
