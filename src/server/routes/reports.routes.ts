/**
 * User Reports Routes
 * Allows users to report other users, content, etc.
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { and, desc, eq, gte } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles, userReports } from '../db/schema.js'

const router = express.Router()

/**
 * Submit a report
 * POST /api/reports
 */
router.post('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { reportedUserId, reportType, reason, messageId, chatId, additionalDetails } = req.body
    const reporterId = req.user!.id

    // Validate input
    if (!reportedUserId || !reportType || !reason) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'reportedUserId, reportType, and reason are required'
      })
    }

    // Validate report type
    const validTypes = ['harassment', 'spam', 'inappropriate_content', 'fake_profile', 'underage', 'other']
    if (!validTypes.includes(reportType)) {
      return res.status(400).json({
        error: 'Invalid report type',
        message: `Report type must be one of: ${validTypes.join(', ')}`
      })
    }

    // Prevent self-reporting
    if (reporterId === reportedUserId) {
      return res.status(400).json({
        error: 'Cannot report yourself'
      })
    }

    // Check if user already reported this user recently (within 24 hours)
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    // Build query for duplicate check
    const duplicateConditions = [
      eq(userReports.reporterId, reporterId),
      eq(userReports.reportedUserId, reportedUserId),
      gte(userReports.createdAt, oneDayAgo.toISOString()),
    ]

    // If reporting a specific message, check for duplicate message reports
    if (messageId) {
      duplicateConditions.push(eq(userReports.messageId, messageId))
    }

    const existingRows = await db.select({ id: userReports.id }).from(userReports).where(and(...duplicateConditions)).limit(1)
    const existingReport = existingRows[0]

    if (existingReport) {
      return res.status(429).json({
        error: 'Report already submitted',
        message: messageId 
          ? 'You have already reported this message.'
          : 'You have already reported this user recently. Please wait before submitting another report.'
      })
    }

    // Build report data
    const reportData: typeof userReports.$inferInsert = {
      reporterId,
      reportedUserId,
      reportType,
      reason,
      status: 'pending',
    }

    // Add optional fields if provided
    if (messageId) {
      reportData.messageId = messageId
    }
    if (chatId) {
      reportData.chatId = chatId
    }
    if (additionalDetails) {
      reportData.additionalDetails = additionalDetails
    }

    // Create the report
    let report
    try {
      const rows = await db.insert(userReports).values(reportData).returning()
      report = rows[0]
    } catch (error) {
      console.error('Error creating report:', error)
      return res.status(500).json({
        error: 'Failed to submit report',
        message: 'An error occurred while submitting your report. Please try again.'
      })
    }

    console.log(`📝 Report submitted: ${reporterId} reported ${reportedUserId} for ${reportType}${messageId ? ` (message: ${messageId})` : ''}`)

    return res.status(201).json({
      success: true,
      message: 'Report submitted successfully. Our team will review it shortly.',
      reportId: report.id
    })
  } catch (error) {
    console.error('Submit report error:', error)
    return res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to submit report. Please try again later.'
    })
  }
})

/**
 * Get user's submitted reports
 * GET /api/reports/my-reports
 */
router.get('/my-reports', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    let reports
    try {
      const rows = await db.select({
        id: userReports.id,
        report_type: userReports.reportType,
        reason: userReports.reason,
        status: userReports.status,
        created_at: userReports.createdAt,
        reported_user_id: profiles.id,
        reported_user_first_name: profiles.firstName,
        reported_user_last_name: profiles.lastName,
        reported_user_photo: profiles.profilePhotoUrl,
      })
        .from(userReports)
        .leftJoin(profiles, eq(profiles.id, userReports.reportedUserId))
        .where(eq(userReports.reporterId, userId))
        .orderBy(desc(userReports.createdAt))

      reports = rows.map(r => ({
        id: r.id,
        report_type: r.report_type,
        reason: r.reason,
        status: r.status,
        created_at: r.created_at,
        reported_user: r.reported_user_id ? {
          id: r.reported_user_id,
          first_name: r.reported_user_first_name,
          last_name: r.reported_user_last_name,
          profile_photo_url: r.reported_user_photo,
        } : null,
      }))
    } catch (error) {
      console.error('Error fetching user reports:', error)
      return res.status(500).json({ error: 'Failed to fetch reports' })
    }

    return res.json({ reports: reports || [] })
  } catch (error) {
    console.error('Get my reports error:', error)
    return res.status(500).json({ error: 'Failed to fetch reports' })
  }
})

export default router
