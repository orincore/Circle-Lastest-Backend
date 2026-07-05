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
import { and, asc, desc, eq, gte, lte, ne, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../config/db.js'
import { userReports, profiles } from '../db/schema.js'

const router = express.Router()

// ============================================
// Report Listing & Filtering
// ============================================

const SORTABLE_COLUMNS: Record<string, any> = {
  created_at: userReports.createdAt,
  updated_at: userReports.updatedAt,
  resolved_at: userReports.resolvedAt,
  status: userReports.status,
  report_type: userReports.reportType,
}

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

    // Build filters
    const conditions = []
    if (status !== 'all') conditions.push(eq(userReports.status, status as string))
    if (type !== 'all') conditions.push(eq(userReports.reportType, type as string))
    if (reporterId) conditions.push(eq(userReports.reporterId, reporterId as string))
    if (reportedUserId) conditions.push(eq(userReports.reportedUserId, reportedUserId as string))
    if (startDate) conditions.push(gte(userReports.createdAt, startDate as string))
    if (endDate) conditions.push(lte(userReports.createdAt, endDate as string))

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(userReports).where(whereClause)

    // Sorting
    const ascending = sortOrder === 'asc'
    const sortColumn = SORTABLE_COLUMNS[sortBy as string] || userReports.createdAt
    const orderFn = ascending ? asc : desc

    const reporterProfiles = alias(profiles, 'reporter_profiles')
    const reportedUserProfiles = alias(profiles, 'reported_user_profiles')
    const moderatorProfiles = alias(profiles, 'moderator_profiles')

    const rows = await db.select({
      id: userReports.id,
      report_type: userReports.reportType,
      reason: userReports.reason,
      status: userReports.status,
      action_taken: userReports.actionTaken,
      created_at: userReports.createdAt,
      updated_at: userReports.updatedAt,
      resolved_at: userReports.resolvedAt,
      reporter_id: reporterProfiles.id,
      reporter_first_name: reporterProfiles.firstName,
      reporter_last_name: reporterProfiles.lastName,
      reporter_email: reporterProfiles.email,
      reporter_photo: reporterProfiles.profilePhotoUrl,
      reported_user_id: reportedUserProfiles.id,
      reported_user_first_name: reportedUserProfiles.firstName,
      reported_user_last_name: reportedUserProfiles.lastName,
      reported_user_email: reportedUserProfiles.email,
      reported_user_photo: reportedUserProfiles.profilePhotoUrl,
      reported_user_is_suspended: reportedUserProfiles.isSuspended,
      moderator_id: moderatorProfiles.id,
      moderator_first_name: moderatorProfiles.firstName,
      moderator_last_name: moderatorProfiles.lastName,
    })
      .from(userReports)
      .leftJoin(reporterProfiles, eq(reporterProfiles.id, userReports.reporterId))
      .leftJoin(reportedUserProfiles, eq(reportedUserProfiles.id, userReports.reportedUserId))
      .leftJoin(moderatorProfiles, eq(moderatorProfiles.id, userReports.moderatorId))
      .where(whereClause)
      .orderBy(orderFn(sortColumn))
      .limit(limitNum)
      .offset(offset)

    const reports = rows.map(r => ({
      id: r.id,
      report_type: r.report_type,
      reason: r.reason,
      status: r.status,
      action_taken: r.action_taken,
      created_at: r.created_at,
      updated_at: r.updated_at,
      resolved_at: r.resolved_at,
      reporter: r.reporter_id ? {
        id: r.reporter_id,
        first_name: r.reporter_first_name,
        last_name: r.reporter_last_name,
        email: r.reporter_email,
        profile_photo_url: r.reporter_photo,
      } : null,
      reported_user: r.reported_user_id ? {
        id: r.reported_user_id,
        first_name: r.reported_user_first_name,
        last_name: r.reported_user_last_name,
        email: r.reported_user_email,
        profile_photo_url: r.reported_user_photo,
        is_suspended: r.reported_user_is_suspended,
      } : null,
      moderator: r.moderator_id ? {
        id: r.moderator_id,
        first_name: r.moderator_first_name,
        last_name: r.moderator_last_name,
      } : null,
    }))

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

    const reporterProfiles = alias(profiles, 'reporter_profiles_d')
    const reportedUserProfiles = alias(profiles, 'reported_user_profiles_d')
    const moderatorProfiles = alias(profiles, 'moderator_profiles_d')

    // Get report with full details
    const [row] = await db.select({
      id: userReports.id,
      reporter_id: userReports.reporterId,
      reported_user_id: userReports.reportedUserId,
      report_type: userReports.reportType,
      reason: userReports.reason,
      evidence: userReports.evidence,
      status: userReports.status,
      moderator_id: userReports.moderatorId,
      moderator_notes: userReports.moderatorNotes,
      action_taken: userReports.actionTaken,
      created_at: userReports.createdAt,
      updated_at: userReports.updatedAt,
      resolved_at: userReports.resolvedAt,
      message_id: userReports.messageId,
      chat_id: userReports.chatId,
      additional_details: userReports.additionalDetails,
      reporter_profile_id: reporterProfiles.id,
      reporter_first_name: reporterProfiles.firstName,
      reporter_last_name: reporterProfiles.lastName,
      reporter_email: reporterProfiles.email,
      reporter_username: reporterProfiles.username,
      reporter_photo: reporterProfiles.profilePhotoUrl,
      reporter_created_at: reporterProfiles.createdAt,
      reported_user_profile_id: reportedUserProfiles.id,
      reported_user_first_name: reportedUserProfiles.firstName,
      reported_user_last_name: reportedUserProfiles.lastName,
      reported_user_email: reportedUserProfiles.email,
      reported_user_username: reportedUserProfiles.username,
      reported_user_photo: reportedUserProfiles.profilePhotoUrl,
      reported_user_is_suspended: reportedUserProfiles.isSuspended,
      reported_user_suspension_reason: reportedUserProfiles.suspensionReason,
      reported_user_created_at: reportedUserProfiles.createdAt,
      moderator_profile_id: moderatorProfiles.id,
      moderator_first_name: moderatorProfiles.firstName,
      moderator_last_name: moderatorProfiles.lastName,
      moderator_email: moderatorProfiles.email,
    })
      .from(userReports)
      .leftJoin(reporterProfiles, eq(reporterProfiles.id, userReports.reporterId))
      .leftJoin(reportedUserProfiles, eq(reportedUserProfiles.id, userReports.reportedUserId))
      .leftJoin(moderatorProfiles, eq(moderatorProfiles.id, userReports.moderatorId))
      .where(eq(userReports.id, reportId))
      .limit(1)

    if (!row) {
      return res.status(404).json({ error: 'Report not found' })
    }

    const report = {
      id: row.id,
      reporter_id: row.reporter_id,
      reported_user_id: row.reported_user_id,
      report_type: row.report_type,
      reason: row.reason,
      evidence: row.evidence,
      status: row.status,
      moderator_id: row.moderator_id,
      moderator_notes: row.moderator_notes,
      action_taken: row.action_taken,
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_at: row.resolved_at,
      message_id: row.message_id,
      chat_id: row.chat_id,
      additional_details: row.additional_details,
      reporter: row.reporter_profile_id ? {
        id: row.reporter_profile_id,
        first_name: row.reporter_first_name,
        last_name: row.reporter_last_name,
        email: row.reporter_email,
        username: row.reporter_username,
        profile_photo_url: row.reporter_photo,
        created_at: row.reporter_created_at,
      } : null,
      reported_user: row.reported_user_profile_id ? {
        id: row.reported_user_profile_id,
        first_name: row.reported_user_first_name,
        last_name: row.reported_user_last_name,
        email: row.reported_user_email,
        username: row.reported_user_username,
        profile_photo_url: row.reported_user_photo,
        is_suspended: row.reported_user_is_suspended,
        suspension_reason: row.reported_user_suspension_reason,
        created_at: row.reported_user_created_at,
      } : null,
      moderator: row.moderator_profile_id ? {
        id: row.moderator_profile_id,
        first_name: row.moderator_first_name,
        last_name: row.moderator_last_name,
        email: row.moderator_email,
      } : null,
    }

    // Get reported user's previous reports
    const [{ count: previousReportsCount }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports)
      .where(and(eq(userReports.reportedUserId, report.reported_user_id as string), ne(userReports.id, reportId)))

    const previousReports = await db.select({
      id: userReports.id,
      report_type: userReports.reportType,
      status: userReports.status,
      created_at: userReports.createdAt,
    })
      .from(userReports)
      .where(and(eq(userReports.reportedUserId, report.reported_user_id as string), ne(userReports.id, reportId)))
      .orderBy(desc(userReports.createdAt))
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
      moderatorId: req.user!.id,
      updatedAt: new Date().toISOString()
    }

    if (actionTaken) {
      updateData.actionTaken = actionTaken
    }

    if (moderatorNotes) {
      updateData.moderatorNotes = moderatorNotes
    }

    if (status === 'resolved' || status === 'dismissed') {
      updateData.resolvedAt = new Date().toISOString()
    }

    await db.update(userReports).set(updateData).where(eq(userReports.id, reportId))

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
    const [report] = await db.select({
      reported_user_id: userReports.reportedUserId,
      report_type: userReports.reportType,
    }).from(userReports).where(eq(userReports.id, reportId)).limit(1)

    if (!report) {
      return res.status(404).json({ error: 'Report not found' })
    }

    // Take action on reported user
    if (action === 'suspend' || action === 'ban') {
      const suspensionEndsAt = action === 'ban' ? null : (
        suspensionDuration ? new Date(Date.now() + suspensionDuration * 24 * 60 * 60 * 1000).toISOString() : null
      )

      await db.update(profiles).set({
        isSuspended: true,
        suspensionReason: reason || `Report resolved: ${report.report_type}`,
        suspensionEndsAt,
        suspendedAt: new Date().toISOString(),
        suspendedBy: req.user!.id
      }).where(eq(profiles.id, report.reported_user_id as string))
    }

    // Update report status
    await db.update(userReports).set({
      status: 'resolved',
      actionTaken: action,
      moderatorNotes: reason,
      moderatorId: req.user!.id,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).where(eq(userReports.id, reportId))

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

    await db.update(userReports).set({
      status: 'dismissed',
      actionTaken: 'no_action',
      moderatorNotes: reason || 'Report dismissed',
      moderatorId: req.user!.id,
      resolvedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }).where(eq(userReports.id, reportId))

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
    const [report] = await db.select({ moderator_notes: userReports.moderatorNotes })
      .from(userReports).where(eq(userReports.id, reportId)).limit(1)

    const existingNotes = report?.moderator_notes || ''
    const timestamp = new Date().toISOString()
    const newNote = `[${timestamp}] ${note}`
    const updatedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote

    await db.update(userReports).set({
      moderatorNotes: updatedNotes,
      updatedAt: timestamp
    }).where(eq(userReports.id, reportId))

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
    const [{ count: totalReports }] = await db.select({ count: sql<number>`count(*)::int` }).from(userReports)

    // Pending reports
    const [{ count: pendingReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.status, 'pending'))

    // Reviewing reports
    const [{ count: reviewingReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.status, 'reviewing'))

    // Resolved reports
    const [{ count: resolvedReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.status, 'resolved'))

    // Reports by type
    const reportsByType = await db.select({ report_type: userReports.reportType }).from(userReports)

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
