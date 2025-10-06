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
import { supabase } from '../config/supabase.js'

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
    console.log('🔍 Admin check - User ID:', req.user?.id)
    const userId = req.user!.id

    // Check admin_roles table for active admin role
    const { data: adminRole, error } = await supabase
      .from('admin_roles')
      .select('id, role, granted_at, is_active')
      .eq('user_id', userId)
      .eq('is_active', true)
      .is('revoked_at', null)
      .single()

    console.log('🔍 Admin check - Query result:', { adminRole, error })

    if (error || !adminRole) {
      console.log('❌ Admin check - User is not an admin')
      return res.json({
        isAdmin: false,
        role: null
      })
    }

    console.log('✅ Admin check - User is admin:', adminRole.role)
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
 * Get admin profile with stats
 * GET /api/admin/profile
 */
router.get('/profile', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const userId = req.user!.id

    // Get user profile
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email, profile_photo_url, created_at')
      .eq('id', userId)
      .single()

    if (profileError) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    // Get admin stats
    const { count: actionsCount } = await supabase
      .from('admin_audit_logs')
      .select('id', { count: 'exact', head: true })
      .eq('admin_id', userId)

    const { count: reportsHandled } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('moderator_id', userId)
      .eq('status', 'resolved')

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
    const { data: admins, error } = await supabase
      .from('admin_roles')
      .select(`
        id,
        role,
        granted_at,
        is_active,
        user:profiles!admin_roles_user_id_fkey (
          id,
          first_name,
          last_name,
          email,
          profile_photo_url
        ),
        granted_by_user:profiles!admin_roles_granted_by_fkey (
          id,
          first_name,
          last_name
        )
      `)
      .order('granted_at', { ascending: false })

    if (error) {
      console.error('Error fetching admins:', error)
      return res.status(500).json({ error: 'Failed to fetch admins' })
    }

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
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })

    // Active users (logged in within last 7 days)
    const sevenDaysAgo = new Date()
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

    const { count: activeUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .gte('last_seen', sevenDaysAgo.toISOString())

    // New users (registered in last 30 days)
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)

    const { count: newUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', thirtyDaysAgo.toISOString())

    // Pending reports
    const { count: pendingReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    // Total messages (last 24 hours)
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    const { count: recentMessages } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', oneDayAgo.toISOString())

    // Total friendships
    const { count: totalFriendships } = await supabase
      .from('friendships')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')

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

    const { data: actions, error } = await supabase
      .from('admin_audit_logs')
      .select(`
        id,
        action,
        target_type,
        target_id,
        details,
        created_at,
        admin:profiles!admin_audit_logs_admin_id_fkey (
          id,
          first_name,
          last_name,
          profile_photo_url
        )
      `)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('Error fetching recent actions:', error)
      return res.status(500).json({ error: 'Failed to fetch recent actions' })
    }

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

    let query = supabase
      .from('admin_audit_logs')
      .select(`
        id,
        action,
        target_type,
        target_id,
        details,
        ip_address,
        created_at,
        admin:profiles!admin_audit_logs_admin_id_fkey (
          id,
          first_name,
          last_name,
          email,
          profile_photo_url
        )
      `, { count: 'exact' })

    // Apply filters
    if (adminId) {
      query = query.eq('admin_id', adminId)
    }
    if (action) {
      query = query.eq('action', action)
    }
    if (targetType) {
      query = query.eq('target_type', targetType)
    }
    if (startDate) {
      query = query.gte('created_at', startDate)
    }
    if (endDate) {
      query = query.lte('created_at', endDate)
    }

    const { data: logs, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)

    if (error) {
      console.error('Error fetching audit logs:', error)
      return res.status(500).json({ error: 'Failed to fetch audit logs' })
    }

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
