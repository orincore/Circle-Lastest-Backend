/**
 * Admin User Management Routes
 * Handles user listing, search, filtering, and user actions
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
// User Listing & Search
// ============================================

/**
 * Get users list with pagination, search, and filters
 * GET /api/admin/users
 */
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      page = '1',
      limit = '50',
      search = '',
      status = 'all',
      sortBy = 'created_at',
      sortOrder = 'desc',
      gender,
      minAge,
      maxAge,
      startDate,
      endDate
    } = req.query

    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)
    const offset = (pageNum - 1) * limitNum

    // Build query
    let query = supabase
      .from('profiles')
      .select(`
        id,
        email,
        username,
        first_name,
        last_name,
        age,
        gender,
        phone_number,
        profile_photo_url,
        created_at,
        last_seen,
        is_suspended,
        suspension_reason,
        deleted_at
      `, { count: 'exact' })

    // Search filter
    if (search) {
      const searchTerm = `%${search}%`
      query = query.or(`email.ilike.${searchTerm},username.ilike.${searchTerm},first_name.ilike.${searchTerm},last_name.ilike.${searchTerm},phone_number.ilike.${searchTerm}`)
    }

    // Status filter
    if (status === 'active') {
      query = query.is('deleted_at', null).eq('is_suspended', false)
    } else if (status === 'suspended') {
      query = query.eq('is_suspended', true)
    } else if (status === 'deleted') {
      query = query.not('deleted_at', 'is', null)
    }

    // Gender filter
    if (gender) {
      query = query.eq('gender', gender)
    }

    // Age filter
    if (minAge) {
      query = query.gte('age', parseInt(minAge as string))
    }
    if (maxAge) {
      query = query.lte('age', parseInt(maxAge as string))
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
    const { data: users, error, count } = await query
      .range(offset, offset + limitNum - 1)

    if (error) {
      console.error('Error fetching users:', error)
      return res.status(500).json({ error: 'Failed to fetch users' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'view_users', 'users', null, {
      filters: { search, status, gender, minAge, maxAge },
      page: pageNum,
      limit: limitNum
    })

    return res.json({
      users,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  } catch (error) {
    console.error('User list error:', error)
    return res.status(500).json({ error: 'Failed to fetch users' })
  }
})

/**
 * Quick search for users (for modals/autocomplete)
 * GET /api/admin/users/search
 */
router.get('/search', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { q = '', limit = '10' } = req.query
    const searchTerm = (q as string).trim()
    const limitNum = Math.min(parseInt(limit as string) || 10, 50)

    if (searchTerm.length < 2) {
      return res.json({ users: [] })
    }

    const searchPattern = `%${searchTerm}%`
    
    const { data: users, error } = await supabase
      .from('profiles')
      .select(`
        id,
        email,
        username,
        first_name,
        last_name,
        age,
        gender,
        profile_photo_url
      `)
      .is('deleted_at', null)
      .or(`email.ilike.${searchPattern},username.ilike.${searchPattern},first_name.ilike.${searchPattern},last_name.ilike.${searchPattern}`)
      .limit(limitNum)

    if (error) {
      console.error('Error searching users:', error)
      return res.status(500).json({ error: 'Failed to search users' })
    }

    return res.json({ users: users || [] })
  } catch (error) {
    console.error('User search error:', error)
    return res.status(500).json({ error: 'Failed to search users' })
  }
})

/**
 * Get user details by ID
 * GET /api/admin/users/:userId
 */
router.get('/:userId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    // Get user profile
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single()

    if (userError || !user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get user statistics
    const { count: friendsCount } = await supabase
      .from('friendships')
      .select('id', { count: 'exact', head: true })
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .eq('status', 'active')

    const { count: messagesCount } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('sender_id', userId)

    const { count: reportsReceived } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('reported_user_id', userId)

    const { count: reportsSent } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('reporter_id', userId)

    // Log the action
    await logAdminAction(req.user!.id, 'view_user_details', 'user', userId, {
      userEmail: user.email
    })

    return res.json({
      user,
      stats: {
        friendsCount: friendsCount || 0,
        messagesCount: messagesCount || 0,
        reportsReceived: reportsReceived || 0,
        reportsSent: reportsSent || 0
      }
    })
  } catch (error) {
    console.error('User details error:', error)
    return res.status(500).json({ error: 'Failed to fetch user details' })
  }
})

// ============================================
// User Actions
// ============================================

/**
 * Suspend user
 * POST /api/admin/users/:userId/suspend
 */
router.post('/:userId/suspend', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { reason, duration } = req.body

    if (!reason) {
      return res.status(400).json({ error: 'Suspension reason is required' })
    }

    // Calculate suspension end date if duration provided (in days)
    let suspensionEndsAt = null
    if (duration && duration > 0) {
      const endDate = new Date()
      endDate.setDate(endDate.getDate() + duration)
      suspensionEndsAt = endDate.toISOString()
    }

    // Update user
    const { error } = await supabase
      .from('profiles')
      .update({
        is_suspended: true,
        suspension_reason: reason,
        suspension_ends_at: suspensionEndsAt,
        suspended_at: new Date().toISOString(),
        suspended_by: req.user!.id
      })
      .eq('id', userId)

    if (error) {
      console.error('Error suspending user:', error)
      return res.status(500).json({ error: 'Failed to suspend user' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'suspend_user', 'user', userId, {
      reason,
      duration,
      suspensionEndsAt
    })

    return res.json({
      success: true,
      message: 'User suspended successfully'
    })
  } catch (error) {
    console.error('Suspend user error:', error)
    return res.status(500).json({ error: 'Failed to suspend user' })
  }
})

/**
 * Unsuspend user
 * POST /api/admin/users/:userId/unsuspend
 */
router.post('/:userId/unsuspend', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    // Update user
    const { error } = await supabase
      .from('profiles')
      .update({
        is_suspended: false,
        suspension_reason: null,
        suspension_ends_at: null,
        suspended_at: null,
        suspended_by: null
      })
      .eq('id', userId)

    if (error) {
      console.error('Error unsuspending user:', error)
      return res.status(500).json({ error: 'Failed to unsuspend user' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'unsuspend_user', 'user', userId, {})

    return res.json({
      success: true,
      message: 'User unsuspended successfully'
    })
  } catch (error) {
    console.error('Unsuspend user error:', error)
    return res.status(500).json({ error: 'Failed to unsuspend user' })
  }
})

/**
 * Delete user (soft delete)
 * DELETE /api/admin/users/:userId
 */
router.delete('/:userId', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { reason } = req.body

    // Soft delete user
    const { error } = await supabase
      .from('profiles')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: req.user!.id,
        deletion_reason: reason || 'Admin deletion'
      })
      .eq('id', userId)

    if (error) {
      console.error('Error deleting user:', error)
      return res.status(500).json({ error: 'Failed to delete user' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'delete_user', 'user', userId, {
      reason: reason || 'Admin deletion'
    })

    return res.json({
      success: true,
      message: 'User deleted successfully'
    })
  } catch (error) {
    console.error('Delete user error:', error)
    return res.status(500).json({ error: 'Failed to delete user' })
  }
})

/**
 * Restore deleted user
 * POST /api/admin/users/:userId/restore
 */
router.post('/:userId/restore', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    // Restore user
    const { error } = await supabase
      .from('profiles')
      .update({
        deleted_at: null,
        deleted_by: null,
        deletion_reason: null
      })
      .eq('id', userId)

    if (error) {
      console.error('Error restoring user:', error)
      return res.status(500).json({ error: 'Failed to restore user' })
    }

    // Log the action
    await logAdminAction(req.user!.id, 'restore_user', 'user', userId, {})

    return res.json({
      success: true,
      message: 'User restored successfully'
    })
  } catch (error) {
    console.error('Restore user error:', error)
    return res.status(500).json({ error: 'Failed to restore user' })
  }
})

/**
 * Get user activity history
 * GET /api/admin/users/:userId/activity
 */
router.get('/:userId/activity', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params
    const { limit = '50' } = req.query

    // Get recent messages
    const { data: messages } = await supabase
      .from('messages')
      .select('id, content, created_at, chat_id')
      .eq('sender_id', userId)
      .order('created_at', { ascending: false })
      .limit(parseInt(limit as string))

    // Get recent friend requests
    const { data: friendRequests } = await supabase
      .from('friendships')
      .select('id, created_at, status')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(20)

    // Get reports involving user
    const { data: reports } = await supabase
      .from('user_reports')
      .select('*')
      .or(`reporter_id.eq.${userId},reported_user_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(20)

    return res.json({
      messages: messages || [],
      friendRequests: friendRequests || [],
      reports: reports || []
    })
  } catch (error) {
    console.error('User activity error:', error)
    return res.status(500).json({ error: 'Failed to fetch user activity' })
  }
})

/**
 * Bulk user actions
 * POST /api/admin/users/bulk-action
 */
router.post('/bulk-action', requireAuth, requireAdmin, requireModerator, async (req: AdminRequest, res) => {
  try {
    const { userIds, action, reason } = req.body

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'User IDs array is required' })
    }

    if (!action || !['suspend', 'unsuspend', 'delete'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' })
    }

    let updateData: any = {}
    let actionName = ''

    switch (action) {
      case 'suspend':
        updateData = {
          is_suspended: true,
          suspension_reason: reason || 'Bulk suspension',
          suspended_at: new Date().toISOString(),
          suspended_by: req.user!.id
        }
        actionName = 'bulk_suspend_users'
        break
      case 'unsuspend':
        updateData = {
          is_suspended: false,
          suspension_reason: null,
          suspension_ends_at: null,
          suspended_at: null,
          suspended_by: null
        }
        actionName = 'bulk_unsuspend_users'
        break
      case 'delete':
        updateData = {
          deleted_at: new Date().toISOString(),
          deleted_by: req.user!.id,
          deletion_reason: reason || 'Bulk deletion'
        }
        actionName = 'bulk_delete_users'
        break
    }

    // Perform bulk update
    const { error } = await supabase
      .from('profiles')
      .update(updateData)
      .in('id', userIds)

    if (error) {
      console.error('Bulk action error:', error)
      return res.status(500).json({ error: 'Failed to perform bulk action' })
    }

    // Log the action
    await logAdminAction(req.user!.id, actionName, 'users', null, {
      userIds,
      action,
      reason,
      count: userIds.length
    })

    return res.json({
      success: true,
      message: `Bulk ${action} completed successfully`,
      affectedUsers: userIds.length
    })
  } catch (error) {
    console.error('Bulk action error:', error)
    return res.status(500).json({ error: 'Failed to perform bulk action' })
  }
})

export default router
