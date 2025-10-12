/**
 * Public Stats Routes
 * Provides public statistics for the app (no authentication required)
 */

import express from 'express'
import { supabase } from '../config/supabase.js'

const router = express.Router()

/**
 * Get public app statistics
 * GET /api/public/stats
 */
router.get('/stats', async (req, res) => {
  try {
    // Get total user count (excluding deleted accounts)
    const { count: totalUsers } = await supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .is('deleted_at', null)

    // Get total matches count
    const { count: totalMatches } = await supabase
      .from('friendships')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')

    // Get total messages count (optional - can be heavy on large databases)
    const { count: totalMessages } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })

    return res.json({
      success: true,
      stats: {
        totalUsers: totalUsers || 0,
        totalMatches: totalMatches || 0,
        totalMessages: totalMessages || 0,
        goal: 10000, // 10k users goal
      }
    })
  } catch (error) {
    console.error('Error fetching public stats:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch statistics'
    })
  }
})

export default router
