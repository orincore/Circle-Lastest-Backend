/**
 * User Reports Routes
 * Allows users to report other users, content, etc.
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'

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
    let duplicateQuery = supabase
      .from('user_reports')
      .select('id')
      .eq('reporter_id', reporterId)
      .eq('reported_user_id', reportedUserId)
      .gte('created_at', oneDayAgo.toISOString())

    // If reporting a specific message, check for duplicate message reports
    if (messageId) {
      duplicateQuery = duplicateQuery.eq('message_id', messageId)
    }

    const { data: existingReport } = await duplicateQuery.maybeSingle()

    if (existingReport) {
      return res.status(429).json({
        error: 'Report already submitted',
        message: messageId 
          ? 'You have already reported this message.'
          : 'You have already reported this user recently. Please wait before submitting another report.'
      })
    }

    // Build report data
    const reportData: any = {
      reporter_id: reporterId,
      reported_user_id: reportedUserId,
      report_type: reportType,
      reason: reason,
      status: 'pending'
    }

    // Add optional fields if provided
    if (messageId) {
      reportData.message_id = messageId
    }
    if (chatId) {
      reportData.chat_id = chatId
    }
    if (additionalDetails) {
      reportData.additional_details = additionalDetails
    }

    // Create the report
    const { data: report, error } = await supabase
      .from('user_reports')
      .insert(reportData)
      .select()
      .single()

    if (error) {
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

    const { data: reports, error } = await supabase
      .from('user_reports')
      .select(`
        id,
        report_type,
        reason,
        status,
        created_at,
        reported_user:profiles!user_reports_reported_user_id_fkey (
          id,
          first_name,
          last_name,
          profile_photo_url
        )
      `)
      .eq('reporter_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
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
