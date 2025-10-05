/**
 * Admin Report Management Routes
 * Handles user reports, moderation, and content review
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import {
  requireAdmin,
  requireModerator,
  AdminRequest,
  logAdminAction
} from '../middleware/adminAuth.js'
import { supabase } from '../config/supabase.js'

const router = express.Router()

// ============================================
// Report Listing & Filtering
// ============================================

/**
 * Get reports list with pagination and filters
 * GET /api/admin/reports
 */
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      page = '1',
      limit = '50',
      status = 'all',
      type = 'all',
      sortBy = 'created_at',
      sortOrder = 'desc',
      reporterId,
      reportedUserId,
      startDate,
      endDate
    } = req.query

    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum

    // Build query
    let query = supabase
      .from('user_reports')
      .select(`
        id,
        report_type,
        reason,
        status,
        action_taken,
        created_at,
        updated_at,
        resolved_at,
        reporter:profiles!user_reports_reporter_id_fkey (
          id,
          first_name,
          last_name,
          email,
          profile_photo_url
        ),
        reported_user:profiles!user_reports_reported_user_id_fkey (
          id,
          first_name,
          last_name,
          email,
          profile_photo_url,
          is_suspended
        ),
        moderator:profiles!user_reports_moderator_id_fkey (
          id,
          first_name,
          last_name
        )
      `, { count: 'exact' })

    // Status filter
    if (status !== 'all') {
      query = query.eq('status', status)
    }

    // Type filter
    if (type !== 'all') {
      query = query.eq('report_type', type)
    }

    // Reporter filter
    if (reporterId) {
      query = query.eq('reporter_id', reporterId)
    }

    // Reported user filter
    if (reportedUserId) {
      query = query.eq('reported_user_id', reportedUserId)
    }

    // Date range filter
    if (startDate) {
      query = query.gte('created_at', startDate)
    }
    if (endDate) {
      query = query.lte('created_at', endDate)
    }

    // Sorting
    const ascending = sortOrder === 'asc'
    query = query.order(sortBy as string, { ascending })

    // Pagination
    const { data: reports, error, count } = await query
      .range(offset, offset + limitNum - 1)

    if (error) {
      console.error('Error fetching reports:', error)
      return res.status(500).json({ error: 'Failed to fetch reports' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'view_reports', 'reports', null, {
      filters: { status, type, reporterId, reportedUserId },
      page: pageNum,
      limit: limitNum
    })

    return res.json({
      reports,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  } catch (error) {
    console.error('Report list error:', error)
    return res.status(500).json({ error: 'Failed to fetch reports' })
  }
})

/**
 * Get report details by ID
 * GET /api/admin/reports/:reportId
 */
router.get('/:reportId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { reportId } = req.params

    // Get report with full details
    const { data: report, error } = await supabase
      .from('user_reports')
      .select(`
        *,
        reporter:profiles!user_reports_reporter_id_fkey (
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url,
          created_at
        ),
        reported_user:profiles!user_reports_reported_user_id_fkey (
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url,
          is_suspended,
          suspension_reason,
          created_at
        ),
        moderator:profiles!user_reports_moderator_id_fkey (
          id,
          first_name,
          last_name,
          email
        )
      `)
      .eq('id', reportId)
      .single()

    if (error || !report) {
      return res.status(404).json({ error: 'Report not found' })
    }

    // Get reported user's previous reports
    const { data: previousReports, count: previousReportsCount } = await supabase
      .from('user_reports')
      .select('id, report_type, status, created_at', { count: 'exact' })
      .eq('reported_user_id', report.reported_user_id)
      .neq('id', reportId)
      .order('created_at', { ascending: false })
      .limit(10)

    // Log the action
    await logAdminAction(req.user!.id, 'view_report_details', 'report', reportId, {
      reportType: report.report_type,
      reportedUserId: report.reported_user_id
    })

    return res.json({
      report,
      previousReports: previousReports || [],
      previousReportsCount: previousReportsCount || 0
    })
  } catch (error) {
    console.error('Report details error:', error)
    return res.status(500).json({ error: 'Failed to fetch report details' })
  }
})

// ============================================
// Report Actions
// ============================================

/**
 * Update report status
 * PATCH /api/admin/reports/:reportId/status
 */
router.patch('/:reportId/status', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { reportId } = req.params
    const { status, actionTaken, moderatorNotes } = req.body

    if (!status || !['pending', 'reviewing', 'resolved', 'dismissed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    const updateData: any = {
      status,
      moderator_id: req.user!.id,
      updated_at: new Date().toISOString()
    }

    if (actionTaken) {
      updateData.action_taken = actionTaken
    }

    if (moderatorNotes) {
      updateData.moderator_notes = moderatorNotes
    }

    if (status === 'resolved' || status === 'dismissed') {
      updateData.resolved_at = new Date().toISOString()
    }

    const { error } = await supabase
      .from('user_reports')
      .update(updateData)
      .eq('id', reportId)

    if (error) {
      console.error('Error updating report:', error)
      return res.status(500).json({ error: 'Failed to update report' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'update_report_status', 'report', reportId, {
      status,
      actionTaken,
      moderatorNotes
    })

    return res.json({
      success: true,
      message: 'Report status updated successfully'
    })
  } catch (error) {
    console.error('Update report error:', error)
    return res.status(500).json({ error: 'Failed to update report' })
  }
})

/**
 * Resolve report and take action on reported user
 * POST /api/admin/reports/:reportId/resolve
 */
router.post('/:reportId/resolve', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { reportId } = req.params
    const { action, reason, suspensionDuration } = req.body

    // Valid actions: warning, suspend, ban, content_removed, no_action
    if (!action || !['warning', 'suspend', 'ban', 'content_removed', 'no_action'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' })
    }

    // Get report details
    const { data: report, error: reportError } = await supabase
      .from('user_reports')
      .select('reported_user_id, report_type')
      .eq('id', reportId)
      .single()

    if (reportError || !report) {
      return res.status(404).json({ error: 'Report not found' })
    }

    // Take action on reported user
    if (action === 'suspend' || action === 'ban') {
      const suspensionEndsAt = action === 'ban' ? null : (
        suspensionDuration ? new Date(Date.now() + suspensionDuration * 24 * 60 * 60 * 1000).toISOString() : null
      )

      await supabase
        .from('profiles')
        .update({
          is_suspended: true,
          suspension_reason: reason || `Report resolved: ${report.report_type}`,
          suspension_ends_at: suspensionEndsAt,
          suspended_at: new Date().toISOString(),
          suspended_by: req.user!.id
        })
        .eq('id', report.reported_user_id)
    }

    // Update report status
    await supabase
      .from('user_reports')
      .update({
        status: 'resolved',
        action_taken: action,
        moderator_notes: reason,
        moderator_id: req.user!.id,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', reportId)

    // Log the action
    await logAdminAction(req.user!.id, 'resolve_report', 'report', reportId, {
      action,
      reason,
      reportedUserId: report.reported_user_id,
      reportType: report.report_type
    })

    return res.json({
      success: true,
      message: 'Report resolved successfully',
      action
    })
  } catch (error) {
    console.error('Resolve report error:', error)
    return res.status(500).json({ error: 'Failed to resolve report' })
  }
})

/**
 * Dismiss report
 * POST /api/admin/reports/:reportId/dismiss
 */
router.post('/:reportId/dismiss', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { reportId } = req.params
    const { reason } = req.body

    await supabase
      .from('user_reports')
      .update({
        status: 'dismissed',
        action_taken: 'no_action',
        moderator_notes: reason || 'Report dismissed',
        moderator_id: req.user!.id,
        resolved_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', reportId)

    // Log the action
    await logAdminAction(req.user!.id, 'dismiss_report', 'report', reportId, {
      reason
    })

    return res.json({
      success: true,
      message: 'Report dismissed successfully'
    })
  } catch (error) {
    console.error('Dismiss report error:', error)
    return res.status(500).json({ error: 'Failed to dismiss report' })
  }
})

/**
 * Add moderator note to report
 * POST /api/admin/reports/:reportId/notes
 */
router.post('/:reportId/notes', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { reportId } = req.params
    const { note } = req.body

    if (!note) {
      return res.status(400).json({ error: 'Note is required' })
    }

    // Get existing notes
    const { data: report } = await supabase
      .from('user_reports')
      .select('moderator_notes')
      .eq('id', reportId)
      .single()

    const existingNotes = report?.moderator_notes || ''
    const timestamp = new Date().toISOString()
    const newNote = `[${timestamp}] ${note}`
    const updatedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote

    await supabase
      .from('user_reports')
      .update({
        moderator_notes: updatedNotes,
        updated_at: timestamp
      })
      .eq('id', reportId)

    // Log the action
    await logAdminAction(req.user!.id, 'add_report_note', 'report', reportId, {
      note
    })

    return res.json({
      success: true,
      message: 'Note added successfully'
    })
  } catch (error) {
    console.error('Add note error:', error)
    return res.status(500).json({ error: 'Failed to add note' })
  }
})

// ============================================
// Report Statistics
// ============================================

/**
 * Get report statistics
 * GET /api/admin/reports/stats
 */
router.get('/stats/overview', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    // Total reports
    const { count: totalReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })

    // Pending reports
    const { count: pendingReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    // Reviewing reports
    const { count: reviewingReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'reviewing')

    // Resolved reports
    const { count: resolvedReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'resolved')

    // Reports by type
    const { data: reportsByType } = await supabase
      .from('user_reports')
      .select('report_type')

    const typeCount: Record<string, number> = {}
    reportsByType?.forEach(report => {
      typeCount[report.report_type] = (typeCount[report.report_type] || 0) + 1
    })

    return res.json({
      stats: {
        totalReports: totalReports || 0,
        pendingReports: pendingReports || 0,
        reviewingReports: reviewingReports || 0,
        resolvedReports: resolvedReports || 0,
        reportsByType: typeCount
      }
    })
  } catch (error) {
    console.error('Report stats error:', error)
    return res.status(500).json({ error: 'Failed to fetch report statistics' })
  }
})

export default router
