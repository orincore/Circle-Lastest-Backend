/**
 * Admin Panel Routes
 * Handles admin authentication, user management, and system operations
 */

import express from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import {
  requireAdmin,
  requireSuperAdmin,
  requireModerator,
  AdminRequest,
  logAdminAction,
  grantAdminRole,
  revokeAdminRole,
  getAdminRole
} from '../middleware/adminAuth.js'
import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../config/db.js'
import { adminRoles, adminAuditLogs, profiles, userReports, messages, friendships } from '../db/schema.js'

const router = express.Router()

// ============================================
// Admin Authentication & Profile
// ============================================

/**
 * Check if current user is an admin
 * GET /api/admin/check
 */
router.get('/check', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    // Check admin_roles table for active admin role
    const [adminRole] = await db.select({
      id: adminRoles.id,
      role: adminRoles.role,
      granted_at: adminRoles.grantedAt,
      is_active: adminRoles.isActive,
    }).from(adminRoles).where(and(
      eq(adminRoles.userId, userId),
      eq(adminRoles.isActive, true),
      isNull(adminRoles.revokedAt),
    )).limit(1)

    if (!adminRole) {
      return res.json({
        isAdmin: false,
        role: null
      })
    }

    return res.json({
      isAdmin: true,
      role: adminRole.role,
      grantedAt: adminRole.granted_at
    })
  } catch (error) {
    console.error('❌ Admin check error:', error)
    return res.status(500).json({
      error: 'Failed to check admin status'
    })
  }
})

/**
 * Verify admin token and status
 * GET /api/admin/verify
 */
router.get('/verify', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    // Check admin_roles table for active admin role
    const [adminRole] = await db.select({
      id: adminRoles.id,
      role: adminRoles.role,
      granted_at: adminRoles.grantedAt,
      is_active: adminRoles.isActive,
    }).from(adminRoles).where(and(
      eq(adminRoles.userId, userId),
      eq(adminRoles.isActive, true),
      isNull(adminRoles.revokedAt),
    )).limit(1)

    if (!adminRole) {
      return res.status(403).json({
        isAdmin: false,
        error: 'Not authorized as admin'
      })
    }

    return res.json({
      isAdmin: true,
      role: adminRole.role,
      grantedAt: adminRole.granted_at
    })
  } catch (error) {
    console.error('❌ Admin verify error:', error)
    return res.status(500).json({
      error: 'Failed to verify admin status'
    })
  }
})

/**
 * Get admin profile with stats
 * GET /api/admin/profile
 */
router.get('/profile', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const userId = req.user!.id

    // Get user profile
    const [profile] = await db.select({
      id: profiles.id,
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      email: profiles.email,
      profile_photo_url: profiles.profilePhotoUrl,
      created_at: profiles.createdAt,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1)

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Get admin stats
    const [{ count: actionsCount }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(adminAuditLogs).where(eq(adminAuditLogs.adminId, userId))

    const [{ count: reportsHandled }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(and(eq(userReports.moderatorId, userId), eq(userReports.status, 'resolved')))

    return res.json({
      profile,
      admin: req.admin,
      stats: {
        totalActions: actionsCount || 0,
        reportsHandled: reportsHandled || 0
      }
    })
  } catch (error) {
    console.error('Admin profile error:', error)
    return res.status(500).json({ error: 'Failed to fetch admin profile' })
  }
})

// ============================================
// Admin Role Management
// ============================================

/**
 * Get all admins
 * GET /api/admin/admins
 */
router.get('/admins', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const grantedByProfiles = alias(profiles, 'granted_by_profiles')

    const rows = await db.select({
      id: adminRoles.id,
      role: adminRoles.role,
      granted_at: adminRoles.grantedAt,
      is_active: adminRoles.isActive,
      user_id: profiles.id,
      user_first_name: profiles.firstName,
      user_last_name: profiles.lastName,
      user_email: profiles.email,
      user_profile_photo_url: profiles.profilePhotoUrl,
      granted_by_id: grantedByProfiles.id,
      granted_by_first_name: grantedByProfiles.firstName,
      granted_by_last_name: grantedByProfiles.lastName,
    })
      .from(adminRoles)
      .leftJoin(profiles, eq(profiles.id, adminRoles.userId))
      .leftJoin(grantedByProfiles, eq(grantedByProfiles.id, adminRoles.grantedBy))
      .orderBy(desc(adminRoles.grantedAt))

    const admins = rows.map(r => ({
      id: r.id,
      role: r.role,
      granted_at: r.granted_at,
      is_active: r.is_active,
      user: r.user_id ? {
        id: r.user_id,
        first_name: r.user_first_name,
        last_name: r.user_last_name,
        email: r.user_email,
        profile_photo_url: r.user_profile_photo_url,
      } : null,
      granted_by_user: r.granted_by_id ? {
        id: r.granted_by_id,
        first_name: r.granted_by_first_name,
        last_name: r.granted_by_last_name,
      } : null,
    }))

    return res.json({ admins })
  } catch (error) {
    console.error('Get admins error:', error)
    return res.status(500).json({ error: 'Failed to fetch admins' })
  }
})

/**
 * Grant admin role to user
 * POST /api/admin/admins/grant
 */
router.post('/admins/grant', requireAuth, requireSuperAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId, role } = req.body
    const grantedBy = req.user!.id

    if (!userId || !role) {
      return res.status(400).json({
        error: 'User ID and role are required'
      })
    }

    if (!['super_admin', 'moderator', 'support'].includes(role)) {
      return res.status(400).json({
        error: 'Invalid role. Must be super_admin, moderator, or support'
      })
    }

    const result = await grantAdminRole(userId, role, grantedBy)

    if (!result.success) {
      return res.status(400).json({ error: result.error })
    }

    return res.json({
      success: true,
      message: `Admin role ${role} granted successfully`
    })
  } catch (error) {
    console.error('Grant admin role error:', error)
    return res.status(500).json({ error: 'Failed to grant admin role' })
  }
})

/**
 * Revoke admin role from user
 * POST /api/admin/admins/revoke
 */
router.post('/admins/revoke', requireAuth, requireSuperAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.body
    const revokedBy = req.user!.id

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    const result = await revokeAdminRole(userId, revokedBy)

    if (!result.success) {
      return res.status(400).json({ error: result.error })
    }

    return res.json({
      success: true,
      message: 'Admin role revoked successfully'
    })
  } catch (error) {
    console.error('Revoke admin role error:', error)
    return res.status(500).json({ error: 'Failed to revoke admin role' })
  }
})

// ============================================
// Dashboard Stats
// ============================================

/**
 * Get dashboard statistics
 * GET /api/admin/dashboard/stats
 */
router.get('/dashboard/stats', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    // Total users
    const [{ count: totalUsers }] = await db.select({ count: sql<number>`count(*)::int` }).from(profiles)

    // Active users (logged in within last 7 days)
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const [{ count: activeUsers }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(profiles).where(gte(profiles.lastSeen, sevenDaysAgo.toISOString()))

    // New users (registered in last 30 days)
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const [{ count: newUsers }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(profiles).where(gte(profiles.createdAt, thirtyDaysAgo.toISOString()))

    // Pending reports
    const [{ count: pendingReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.status, 'pending'))

    // Total messages (last 24 hours)
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    const [{ count: recentMessages }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(messages).where(gte(messages.createdAt, oneDayAgo.toISOString()))

    // Total friendships
    const [{ count: totalFriendships }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(friendships).where(eq(friendships.status, 'active'))

    return res.json({
      stats: {
        totalUsers: totalUsers || 0,
        activeUsers: activeUsers || 0,
        newUsers: newUsers || 0,
        pendingReports: pendingReports || 0,
        recentMessages: recentMessages || 0,
        totalFriendships: totalFriendships || 0
      }
    })
  } catch (error) {
    console.error('Dashboard stats error:', error)
    return res.status(500).json({ error: 'Failed to fetch dashboard stats' })
  }
})

/**
 * Get recent admin actions
 * GET /api/admin/dashboard/recent-actions
 */
router.get('/dashboard/recent-actions', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20

    const rows = await db.select({
      id: adminAuditLogs.id,
      action: adminAuditLogs.action,
      target_type: adminAuditLogs.targetType,
      target_id: adminAuditLogs.targetId,
      details: adminAuditLogs.details,
      created_at: adminAuditLogs.createdAt,
      admin_id: profiles.id,
      admin_first_name: profiles.firstName,
      admin_last_name: profiles.lastName,
      admin_profile_photo_url: profiles.profilePhotoUrl,
    })
      .from(adminAuditLogs)
      .leftJoin(profiles, eq(profiles.id, adminAuditLogs.adminId))
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limit)

    const actions = rows.map(r => ({
      id: r.id,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      details: r.details,
      created_at: r.created_at,
      admin: r.admin_id ? {
        id: r.admin_id,
        first_name: r.admin_first_name,
        last_name: r.admin_last_name,
        profile_photo_url: r.admin_profile_photo_url,
      } : null,
    }))

    return res.json({ actions })
  } catch (error) {
    console.error('Recent actions error:', error)
    return res.status(500).json({ error: 'Failed to fetch recent actions' })
  }
})

// ============================================
// Audit Logs
// ============================================

/**
 * Get audit logs with filters
 * GET /api/admin/audit-logs
 */
router.get('/audit-logs', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      page = '1',
      limit = '50',
      adminId,
      action,
      targetType,
      startDate,
      endDate
    } = req.query

    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum

    // Apply filters
    const conditions = []
    if (adminId) conditions.push(eq(adminAuditLogs.adminId, adminId as string))
    if (action) conditions.push(eq(adminAuditLogs.action, action as string))
    if (targetType) conditions.push(eq(adminAuditLogs.targetType, targetType as string))
    if (startDate) conditions.push(gte(adminAuditLogs.createdAt, startDate as string))
    if (endDate) conditions.push(lte(adminAuditLogs.createdAt, endDate as string))

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(adminAuditLogs).where(whereClause)

    const rows = await db.select({
      id: adminAuditLogs.id,
      action: adminAuditLogs.action,
      target_type: adminAuditLogs.targetType,
      target_id: adminAuditLogs.targetId,
      details: adminAuditLogs.details,
      ip_address: adminAuditLogs.ipAddress,
      created_at: adminAuditLogs.createdAt,
      admin_id: profiles.id,
      admin_first_name: profiles.firstName,
      admin_last_name: profiles.lastName,
      admin_email: profiles.email,
      admin_profile_photo_url: profiles.profilePhotoUrl,
    })
      .from(adminAuditLogs)
      .leftJoin(profiles, eq(profiles.id, adminAuditLogs.adminId))
      .where(whereClause)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limitNum)
      .offset(offset)

    const logs = rows.map(r => ({
      id: r.id,
      action: r.action,
      target_type: r.target_type,
      target_id: r.target_id,
      details: r.details,
      ip_address: r.ip_address,
      created_at: r.created_at,
      admin: r.admin_id ? {
        id: r.admin_id,
        first_name: r.admin_first_name,
        last_name: r.admin_last_name,
        email: r.admin_email,
        profile_photo_url: r.admin_profile_photo_url,
      } : null,
    }))

    return res.json({
      logs,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  } catch (error) {
    console.error('Audit logs error:', error)
    return res.status(500).json({ error: 'Failed to fetch audit logs' })
  }
})

export default router
