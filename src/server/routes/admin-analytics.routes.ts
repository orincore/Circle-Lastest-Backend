/**
 * Admin Analytics Routes
 * Provides detailed analytics and insights for the admin panel
 */

import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin, AdminRequest, logAdminAction } from '../middleware/adminAuth.js'
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles, messages, friendships, userReports } from '../db/schema.js'

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
    const [{ count: totalUsers }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(profiles).where(isNull(profiles.deletedAt))

    const [{ count: newUsers }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(profiles).where(and(gte(profiles.createdAt, startDate.toISOString()), isNull(profiles.deletedAt)))

    const [{ count: activeUsers }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(profiles).where(and(gte(profiles.lastSeen, startDate.toISOString()), isNull(profiles.deletedAt)))

    const [{ count: suspendedUsers }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(profiles).where(eq(profiles.isSuspended, true))

    // Engagement statistics
    const [{ count: totalMessages }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(messages).where(gte(messages.createdAt, startDate.toISOString()))

    const [{ count: totalFriendships }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(friendships).where(eq(friendships.status, 'active'))

    const [{ count: newFriendships }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(friendships).where(and(gte(friendships.createdAt, startDate.toISOString()), eq(friendships.status, 'active')))

    // Report statistics
    const [{ count: totalReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(gte(userReports.createdAt, startDate.toISOString()))

    const [{ count: pendingReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(eq(userReports.status, 'pending'))

    const [{ count: resolvedReports }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(userReports).where(and(eq(userReports.status, 'resolved'), gte(userReports.resolvedAt, startDate.toISOString())))

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
    const registrations = await db.select({ created_at: profiles.createdAt })
      .from(profiles)
      .where(and(gte(profiles.createdAt, startDate.toISOString()), isNull(profiles.deletedAt)))
      .orderBy(profiles.createdAt)

    // Group by date
    const dailyData: Record<string, number> = {}
    registrations?.forEach(user => {
      const date = new Date(user.created_at as string).toISOString().split('T')[0]
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
    const dailyActivity = await db.select({ last_seen: profiles.lastSeen })
      .from(profiles)
      .where(and(gte(profiles.lastSeen, startDate.toISOString()), isNull(profiles.deletedAt)))

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
    const messagesData = await db.select({ created_at: messages.createdAt })
      .from(messages)
      .where(gte(messages.createdAt, startDate.toISOString()))

    const dailyMessages: Record<string, number> = {}
    messagesData?.forEach(msg => {
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
    const genderData = await db.select({ gender: profiles.gender })
      .from(profiles)
      .where(isNull(profiles.deletedAt))

    const genderCount: Record<string, number> = {}
    genderData?.forEach(user => {
      if (user.gender) {
        genderCount[user.gender] = (genderCount[user.gender] || 0) + 1
      }
    })

    // Age distribution
    const ageData = await db.select({ age: profiles.age })
      .from(profiles)
      .where(and(isNull(profiles.deletedAt), sql`${profiles.age} is not null`))

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
      const rows = await db.select({
        sender_id: messages.senderId,
        id: profiles.id,
        first_name: profiles.firstName,
        last_name: profiles.lastName,
        profile_photo_url: profiles.profilePhotoUrl,
      })
        .from(messages)
        .leftJoin(profiles, eq(profiles.id, messages.senderId))
        .limit(1000)

      const messageCounts: Record<string, any> = {}
      rows?.forEach(msg => {
        const userId = msg.sender_id
        if (!messageCounts[userId]) {
          messageCounts[userId] = {
            user: msg.id ? {
              id: msg.id,
              first_name: msg.first_name,
              last_name: msg.last_name,
              profile_photo_url: msg.profile_photo_url,
            } : null,
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
      const data = await db.select({ user1_id: friendships.user1Id, user2_id: friendships.user2Id })
        .from(friendships)
        .where(eq(friendships.status, 'active'))

      const friendCounts: Record<string, number> = {}
      data?.forEach(friendship => {
        friendCounts[friendship.user1_id] = (friendCounts[friendship.user1_id] || 0) + 1
        friendCounts[friendship.user2_id] = (friendCounts[friendship.user2_id] || 0) + 1
      })

      const topUserIds = Object.entries(friendCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, limitNum)
        .map(([userId]) => userId)

      const users = topUserIds.length > 0
        ? await db.select({
            id: profiles.id,
            first_name: profiles.firstName,
            last_name: profiles.lastName,
            profile_photo_url: profiles.profilePhotoUrl,
          }).from(profiles).where(inArray(profiles.id, topUserIds))
        : []

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
    const reports = await db.select({ created_at: userReports.createdAt, report_type: userReports.reportType })
      .from(userReports)
      .where(gte(userReports.createdAt, startDate.toISOString()))

    const dailyReports: Record<string, Record<string, number>> = {}
    reports?.forEach(report => {
      const date = new Date(report.created_at as string).toISOString().split('T')[0]
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
