import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { CirclePointsService } from '../services/circle-points.service.js'

const router = Router()

// Get user's Circle statistics and score
router.get('/stats', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    //console.log('🔍 Fetching Circle stats for user:', userId)
    
    // Update user stats first to ensure they're current
    //console.log('📊 Updating user stats...')
    await CirclePointsService.updateUserStats(userId)
    
    // Get comprehensive stats
    //console.log('📈 Fetching user stats...')
    const stats = await CirclePointsService.getUserStats(userId)
    
    if (!stats) {
      //console.log('❌ No stats found for user:', userId)
      return res.status(404).json({ error: 'User stats not found' })
    }
    
    
    
    // Get performance message and suggestions
    const performanceMessage = await CirclePointsService.getPerformanceMessage(stats, userId)
    const improvementSuggestions = CirclePointsService.getImprovementSuggestions(stats)
    
    res.json({
      stats,
      performanceMessage,
      improvementSuggestions,
      lastUpdated: stats.stats_updated_at
    })
    
  } catch (error) {
    console.error('Error fetching Circle stats:', error)
    res.status(500).json({ error: 'Failed to fetch Circle statistics' })
  }
})

// Record a profile visit
router.post('/profile-visit', requireAuth, async (req: AuthRequest, res) => {
  try {
    const visitorId = req.user!.id
    const { visitedUserId } = req.body
    
    if (!visitedUserId) {
      return res.status(400).json({ error: 'visitedUserId is required' })
    }
    
    if (visitorId === visitedUserId) {
      return res.status(400).json({ error: 'Cannot visit your own profile' })
    }
    
    await CirclePointsService.recordProfileVisit(visitorId, visitedUserId)
    
    res.json({ success: true, message: 'Profile visit recorded' })
    
  } catch (error) {
    console.error('Error recording profile visit:', error)
    res.status(500).json({ error: 'Failed to record profile visit' })
  }
})

// Update user's last active timestamp
router.post('/update-activity', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    await CirclePointsService.updateLastActive(userId)
    
    res.json({ success: true, message: 'Activity updated' })
    
  } catch (error) {
    console.error('Error updating activity:', error)
    res.status(500).json({ error: 'Failed to update activity' })
  }
})

// Manually recalculate Circle points (for debugging/admin)
router.post('/recalculate-points', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    const newPoints = await CirclePointsService.updateCirclePoints(userId)
    await CirclePointsService.updateUserStats(userId)
    
    res.json({ 
      success: true, 
      message: 'Circle points recalculated',
      newPoints 
    })
    
  } catch (error) {
    console.error('Error recalculating points:', error)
    res.status(500).json({ error: 'Failed to recalculate points' })
  }
})

// Get user's recent activities (for debugging)
router.get('/activities', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const limit = parseInt(req.query.limit as string) || 20
    
    const { data: activities, error } = await require('../config/supabase.js').supabase
      .from('user_activities')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)
    
    if (error) {
      console.error('Error fetching activities:', error)
      return res.status(500).json({ error: 'Failed to fetch activities' })
    }
    
    res.json({ activities })
    
  } catch (error) {
    console.error('Error in activities endpoint:', error)
    res.status(500).json({ error: 'Failed to fetch activities' })
  }
})

// Initialize user with basic activities (for new users)
router.post('/initialize', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    //console.log('🚀 Initializing Circle points for user:', userId)
    
    // Record profile completion activity
    await CirclePointsService.recordActivity({
      user_id: userId,
      activity_type: 'profile_completed',
      points_change: 8,
      metadata: { initialization: true, timestamp: new Date().toISOString() }
    })
    
    // Record daily login activity
    await CirclePointsService.recordActivity({
      user_id: userId,
      activity_type: 'daily_login',
      points_change: 3,
      metadata: { initialization: true, timestamp: new Date().toISOString() }
    })
    
    //console.log('✅ User initialized with basic activities')
    
    res.json({ 
      success: true, 
      message: 'Circle points initialized successfully',
      activities_added: ['profile_completed', 'daily_login']
    })
    
  } catch (error) {
    console.error('Error initializing Circle points:', error)
    res.status(500).json({ error: 'Failed to initialize Circle points' })
  }
})

export default router
