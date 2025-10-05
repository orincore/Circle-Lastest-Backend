import { Router } from 'express'
import { supabase } from '../config/supabase.js'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'

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
      event_name: event.event_name,
      user_id: event.user_id,
      session_id: event.session_id,
      timestamp: event.timestamp,
      properties: event.properties || {},
      created_at: new Date().toISOString(),
    }))

    const { error } = await supabase
      .from('analytics_events')
      .insert(analyticsData)

    if (error) {
      console.error('Analytics storage error:', error)
      return res.status(500).json({ error: 'Failed to store analytics data' })
    }

    console.log(`📊 Stored ${events.length} analytics events`)

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
    const { error } = await supabase
      .from('app_versions')
      .insert({
        version: versionData.version,
        build_number: versionData.buildNumber.toString(),
        platform: versionData.platform,
        expo_version: versionData.expoVersion,
        device_id: versionData.deviceId,
        timestamp: versionData.timestamp,
        created_at: new Date().toISOString(),
      })

    if (error) {
      console.error('Version tracking error:', error)
      return res.status(500).json({ error: 'Failed to store version data' })
    }

    console.log(`📱 Tracked app version: ${versionData.version} (${versionData.platform})`)

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
    const { error } = await supabase
      .from('crash_reports')
      .insert({
        crash_id: crashData.id,
        timestamp: crashData.timestamp,
        type: crashData.type,
        is_fatal: crashData.isFatal,
        user_id: crashData.userId,
        session_id: crashData.sessionId,
        error_name: crashData.error.name,
        error_message: crashData.error.message,
        error_stack: crashData.error.stack,
        device_platform: crashData.device.platform,
        device_version: crashData.device.version.toString(),
        device_model: crashData.device.model,
        app_version: crashData.device.appVersion,
        build_number: crashData.device.buildNumber.toString(),
        is_device: crashData.app?.isDevice,
        expo_version: crashData.app?.expoVersion,
        created_at: new Date().toISOString(),
      })

    if (error) {
      console.error('Crash report storage error:', error)
      return res.status(500).json({ error: 'Failed to store crash report' })
    }

    console.log(`💥 Stored crash report: ${crashData.error.name} - ${crashData.error.message}`)

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
    // Get event counts by type
    const { data: eventCounts } = await supabase
      .from('analytics_events')
      .select('event_name')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()) // Last 7 days

    // Get unique users
    const { data: uniqueUsers } = await supabase
      .from('analytics_events')
      .select('user_id')
      .not('user_id', 'is', null)
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

    // Get crash counts
    const { data: crashes } = await supabase
      .from('crash_reports')
      .select('is_fatal')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

    // Get app versions
    const { data: versions } = await supabase
      .from('app_versions')
      .select('version, platform')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())

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
