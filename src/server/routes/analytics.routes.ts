import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth'
import { supabase } from '../config/supabase'
import type { AuthRequest } from '../types/auth'

const router = Router()

// Get overview analytics
router.get('/overview', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { range = '7d' } = req.query
    
    // Calculate date range
    const now = new Date()
    let startDate = new Date()
    
    switch (range) {
      case '7d':
        startDate.setDate(now.getDate() - 7)
        break
      case '30d':
        startDate.setDate(now.getDate() - 30)
        break
      case '90d':
        startDate.setDate(now.getDate() - 90)
        break
      case 'all':
        startDate = new Date('2020-01-01')
        break
    }

    // Get total users
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .is('deleted_at', null)

    // Get new users in range
    const { count: newUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())
      .is('deleted_at', null)

    // Get active users today
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    
    const { count: activeUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .gte('last_active', todayStart.toISOString())
      .is('deleted_at', null)

    // Get total messages
    const { count: totalMessages } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', startDate.toISOString())

    // Get total friendships
    const { count: totalFriendships } = await supabase
      .from('friendships')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active')

    // Calculate growth rates (compare with previous period)
    const prevStartDate = new Date(startDate)
    const daysDiff = Math.floor((now.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    prevStartDate.setDate(prevStartDate.getDate() - daysDiff)

    const { count: prevNewUsers } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', prevStartDate.toISOString())
      .lt('created_at', startDate.toISOString())
      .is('deleted_at', null)

    const { count: prevMessages } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', prevStartDate.toISOString())
      .lt('created_at', startDate.toISOString())

    const { count: prevFriendships } = await supabase
      .from('friendships')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', prevStartDate.toISOString())
      .lt('created_at', startDate.toISOString())

    // Calculate growth percentages
    const userGrowth = prevNewUsers ? Math.round(((newUsers || 0) - (prevNewUsers || 0)) / (prevNewUsers || 1) * 100) : 0
    const messageGrowth = prevMessages ? Math.round(((totalMessages || 0) - (prevMessages || 0)) / (prevMessages || 1) * 100) : 0
    const friendshipGrowth = prevFriendships ? Math.round(((totalFriendships || 0) - (prevFriendships || 0)) / (prevFriendships || 1) * 100) : 0

    // Get top users by activity
    const { data: topUsers } = await supabase
      .from('profiles')
      .select(`
        id,
        first_name,
        last_name,
        messages:messages(count),
        friendships:friendships(count)
      `)
      .is('deleted_at', null)
      .limit(10)

    const formattedTopUsers = topUsers?.map(user => ({
      id: user.id,
      name: `${user.first_name} ${user.last_name}`,
      messageCount: user.messages?.[0]?.count || 0,
      friendCount: user.friendships?.[0]?.count || 0,
    })) || []

    res.json({
      totalUsers: totalUsers || 0,
      newUsers: newUsers || 0,
      activeUsers: activeUsers || 0,
      totalMessages: totalMessages || 0,
      totalFriendships: totalFriendships || 0,
      userGrowth,
      messageGrowth,
      friendshipGrowth,
      messagesPerUser: totalUsers ? Math.round((totalMessages || 0) / totalUsers) : 0,
      friendshipsPerUser: totalUsers ? Math.round((totalFriendships || 0) / totalUsers) : 0,
      topUsers: formattedTopUsers,
      dailyActiveUsers: activeUsers || 0,
      monthlyActiveUsers: totalUsers || 0, // Simplified
      avgSessionDuration: 15, // Placeholder
      retentionRate: 75, // Placeholder
    })
  } catch (error) {
    console.error('Error fetching overview analytics:', error)
    res.status(500).json({ error: 'Failed to fetch analytics' })
  }
})

// Get user growth data
router.get('/user-growth', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    const { range = '7d' } = req.query
    
    const now = new Date()
    let startDate = new Date()
    let groupBy = 'day'
    
    switch (range) {
      case '7d':
        startDate.setDate(now.getDate() - 7)
        groupBy = 'day'
        break
      case '30d':
        startDate.setDate(now.getDate() - 30)
        groupBy = 'day'
        break
      case '90d':
        startDate.setDate(now.getDate() - 90)
        groupBy = 'week'
        break
      case 'all':
        startDate.setFullYear(now.getFullYear() - 1)
        groupBy = 'month'
        break
    }

    // Get user registrations grouped by date
    const { data: growthData } = await supabase
      .from('profiles')
      .select('created_at')
      .gte('created_at', startDate.toISOString())
      .is('deleted_at', null)
      .order('created_at', { ascending: true })

    // Group by date
    const grouped: { [key: string]: number } = {}
    
    growthData?.forEach(user => {
      const date = new Date(user.created_at)
      let key: string
      
      if (groupBy === 'day') {
        key = date.toISOString().split('T')[0]
      } else if (groupBy === 'week') {
        const weekStart = new Date(date)
        weekStart.setDate(date.getDate() - date.getDay())
        key = weekStart.toISOString().split('T')[0]
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      }
      
      grouped[key] = (grouped[key] || 0) + 1
    })

    const data = Object.entries(grouped).map(([date, count]) => ({
      date,
      count,
    }))

    res.json({ data })
  } catch (error) {
    console.error('Error fetching user growth:', error)
    res.status(500).json({ error: 'Failed to fetch user growth data' })
  }
})

// Get demographics
router.get('/demographics', requireAuth, requireAdmin, async (req: AuthRequest, res) => {
  try {
    // Get gender distribution
    const { data: genderData } = await supabase
      .from('profiles')
      .select('gender')
      .is('deleted_at', null)

    const genderCounts: { [key: string]: number } = {}
    genderData?.forEach(user => {
      const gender = user.gender || 'other'
      genderCounts[gender] = (genderCounts[gender] || 0) + 1
    })

    const total = genderData?.length || 1
    const genderDistribution = {
      male: Math.round((genderCounts.male || 0) / total * 100),
      female: Math.round((genderCounts.female || 0) / total * 100),
      other: Math.round((genderCounts.other || 0) / total * 100),
    }

    // Get age distribution
    const { data: ageData } = await supabase
      .from('profiles')
      .select('date_of_birth')
      .is('deleted_at', null)
      .not('date_of_birth', 'is', null)

    const ageCounts: { [key: string]: number } = {
      '18-24': 0,
      '25-34': 0,
      '35-44': 0,
      '45+': 0,
    }

    ageData?.forEach(user => {
      const age = new Date().getFullYear() - new Date(user.date_of_birth).getFullYear()
      if (age >= 18 && age <= 24) ageCounts['18-24']++
      else if (age >= 25 && age <= 34) ageCounts['25-34']++
      else if (age >= 35 && age <= 44) ageCounts['35-44']++
      else if (age >= 45) ageCounts['45+']++
    })

    const ageTotal = ageData?.length || 1
    const ageDistribution = Object.entries(ageCounts).map(([range, count]) => ({
      range,
      count,
      percentage: Math.round(count / ageTotal * 100),
    }))

    res.json({
      genderDistribution,
      ageDistribution,
    })
  } catch (error) {
    console.error('Error fetching demographics:', error)
    res.status(500).json({ error: 'Failed to fetch demographics' })
  }
})

export default router
