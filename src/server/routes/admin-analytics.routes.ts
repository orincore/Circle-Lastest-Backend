/**
 * Admin Analytics Routes
 * Provides detailed analytics and insights for the admin panel
 */

import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin, AdminRequest, logAdminAction } from '../middleware/adminAuth.js'
import { supabase } from '../config/supabase.js'

const router = express.Router()

/**
 * Get overview analytics
 * GET /api/admin/analytics/overview
 */
router.get('/overview', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { timeRange = '30' } = req.query // days
    const days = parseInt(timeRange as string)
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    // User statistics
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null)

    const { count: newUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())
      .is('deleted_at', null)

    const { count: activeUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .gte('last_seen', startDate.toISOString())
      .is('deleted_at', null)

    const { count: suspendedUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('is_suspended', true)

    // Engagement statistics
    const { count: totalMessages } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())

    const { count: totalFriendships } = await supabase
      .from('friendships')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')

    const { count: newFriendships } = await supabase
      .from('friendships')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())
      .eq('status', 'active')

    // Report statistics
    const { count: totalReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())

    const { count: pendingReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending')

    const { count: resolvedReports } = await supabase
      .from('user_reports')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'resolved')
      .gte('resolved_at', startDate.toISOString())

    // Log the action
    await logAdminAction(req.user!.id, 'view_analytics_overview', 'analytics', null, {
      timeRange: days
    })

    return res.json({
      users: {
        total: totalUsers || 0,
        new: newUsers || 0,
        active: activeUsers || 0,
        suspended: suspendedUsers || 0,
      },
      engagement: {
        totalMessages: totalMessages || 0,
        totalFriendships: totalFriendships || 0,
        newFriendships: newFriendships || 0,
      },
      reports: {
        total: totalReports || 0,
        pending: pendingReports || 0,
        resolved: resolvedReports || 0,
      },
      timeRange: days,
    })
  } catch (error) {
    console.error('Analytics overview error:', error)
    return res.status(500).json({ error: 'Failed to fetch analytics' })
  }
})

/**
 * Get user growth data
 * GET /api/admin/analytics/user-growth
 */
router.get('/user-growth', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { days = '30' } = req.query
    const numDays = parseInt(days as string)
    
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    // Get daily user registrations
    const { data: registrations } = await supabase
      .from('profiles')
      .select('created_at')
      .gte('created_at', startDate.toISOString())
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    // Group by date
    const dailyData: Record<string, number> = {}
    registrations?.forEach(user => {
      const date = new Date(user.created_at).toISOString().split('T')[0]
      dailyData[date] = (dailyData[date] || 0) + 1
    })

    const chartData = Object.entries(dailyData).map(([date, count]) => ({
      date,
      count,
    }))

    return res.json({ data: chartData })
  } catch (error) {
    console.error('User growth error:', error)
    return res.status(500).json({ error: 'Failed to fetch user growth data' })
  }
})

/**
 * Get engagement metrics
 * GET /api/admin/analytics/engagement
 */
router.get('/engagement', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { days = '7' } = req.query
    const numDays = parseInt(days as string)
    
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    // Daily active users
    const { data: dailyActivity } = await supabase
      .from('profiles')
      .select('last_seen')
      .gte('last_seen', startDate.toISOString())
      .is('deleted_at', null)

    // Group by date
    const dailyActiveUsers: Record<string, Set<string>> = {}
    dailyActivity?.forEach(user => {
      if (user.last_seen) {
        const date = new Date(user.last_seen).toISOString().split('T')[0]
        if (!dailyActiveUsers[date]) {
          dailyActiveUsers[date] = new Set()
        }
      }
    })

    // Daily messages
    const { data: messages } = await supabase
      .from('messages')
      .select('created_at')
      .gte('created_at', startDate.toISOString())

    const dailyMessages: Record<string, number> = {}
    messages?.forEach(msg => {
      const date = new Date(msg.created_at).toISOString().split('T')[0]
      dailyMessages[date] = (dailyMessages[date] || 0) + 1
    })

    const chartData = Object.entries(dailyMessages).map(([date, count]) => ({
      date,
      messages: count,
      activeUsers: dailyActiveUsers[date]?.size || 0,
    }))

    return res.json({ data: chartData })
  } catch (error) {
    console.error('Engagement metrics error:', error)
    return res.status(500).json({ error: 'Failed to fetch engagement metrics' })
  }
})

/**
 * Get user demographics
 * GET /api/admin/analytics/demographics
 */
router.get('/demographics', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    // Gender distribution
    const { data: genderData } = await supabase
      .from('profiles')
      .select('gender')
      .is('deleted_at', null)

    const genderCount: Record<string, number> = {}
    genderData?.forEach(user => {
      if (user.gender) {
        genderCount[user.gender] = (genderCount[user.gender] || 0) + 1
      }
    })

    // Age distribution
    const { data: ageData } = await supabase
      .from('profiles')
      .select('age')
      .is('deleted_at', null)
      .not('age', 'is', null)

    const ageGroups: Record<string, number> = {
      '18-24': 0,
      '25-34': 0,
      '35-44': 0,
      '45-54': 0,
      '55+': 0,
    }

    ageData?.forEach(user => {
      const age = user.age
      if (age >= 18 && age <= 24) ageGroups['18-24']++
      else if (age >= 25 && age <= 34) ageGroups['25-34']++
      else if (age >= 35 && age <= 44) ageGroups['35-44']++
      else if (age >= 45 && age <= 54) ageGroups['45-54']++
      else if (age >= 55) ageGroups['55+']++
    })

    return res.json({
      gender: genderCount,
      ageGroups,
    })
  } catch (error) {
    console.error('Demographics error:', error)
    return res.status(500).json({ error: 'Failed to fetch demographics' })
  }
})

/**
 * Get top users by activity
 * GET /api/admin/analytics/top-users
 */
router.get('/top-users', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { metric = 'messages', limit = '10' } = req.query
    const limitNum = parseInt(limit as string)

    if (metric === 'messages') {
      // Top users by message count
      const { data } = await supabase
        .from('messages')
        .select('sender_id, profiles!messages_sender_id_fkey(id, first_name, last_name, profile_photo_url)')
        .limit(1000)

      const messageCounts: Record<string, any> = {}
      data?.forEach(msg => {
        const userId = msg.sender_id
        if (!messageCounts[userId]) {
          messageCounts[userId] = {
            user: msg.profiles,
            count: 0,
          }
        }
        messageCounts[userId].count++
      })

      const topUsers = Object.values(messageCounts)
        .sort((a: any, b: any) => b.count - a.count)
        .slice(0, limitNum)

      return res.json({ topUsers, metric: 'messages' })
    } else if (metric === 'friends') {
      // Top users by friend count
      const { data } = await supabase
        .from('friendships')
        .select('user1_id, user2_id')
        .eq('status', 'active')

      const friendCounts: Record<string, number> = {}
      data?.forEach(friendship => {
        friendCounts[friendship.user1_id] = (friendCounts[friendship.user1_id] || 0) + 1
        friendCounts[friendship.user2_id] = (friendCounts[friendship.user2_id] || 0) + 1
      })

      const topUserIds = Object.entries(friendCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, limitNum)
        .map(([userId]) => userId)

      const { data: users } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, profile_photo_url')
        .in('id', topUserIds)

      const topUsers = topUserIds.map(userId => ({
        user: users?.find(u => u.id === userId),
        count: friendCounts[userId],
      }))

      return res.json({ topUsers, metric: 'friends' })
    }

    return res.status(400).json({ error: 'Invalid metric' })
  } catch (error) {
    console.error('Top users error:', error)
    return res.status(500).json({ error: 'Failed to fetch top users' })
  }
})

/**
 * Get report trends
 * GET /api/admin/analytics/report-trends
 */
router.get('/report-trends', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { days = '30' } = req.query
    const numDays = parseInt(days as string)
    
    const startDate = new Date()
    startDate.setDate(startDate.getDate() - numDays)

    // Get reports by type over time
    const { data: reports } = await supabase
      .from('user_reports')
      .select('created_at, report_type')
      .gte('created_at', startDate.toISOString())

    const dailyReports: Record<string, Record<string, number>> = {}
    reports?.forEach(report => {
      const date = new Date(report.created_at).toISOString().split('T')[0]
      if (!dailyReports[date]) {
        dailyReports[date] = {}
      }
      dailyReports[date][report.report_type] = (dailyReports[date][report.report_type] || 0) + 1
    })

    const chartData = Object.entries(dailyReports).map(([date, types]) => ({
      date,
      ...types,
    }))

    return res.json({ data: chartData })
  } catch (error) {
    console.error('Report trends error:', error)
    return res.status(500).json({ error: 'Failed to fetch report trends' })
  }
})

export default router
