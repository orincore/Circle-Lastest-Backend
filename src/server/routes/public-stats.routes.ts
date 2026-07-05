/**
 * Public Stats Routes
 * Provides public statistics for the app (no authentication required)
 */

import express from 'express'
import { db } from '../config/db.js'
import { friendships, messages, profiles } from '../db/schema.js'
import { count, eq, isNull } from 'drizzle-orm'

const router = express.Router()

/**
 * Get public app statistics
 * GET /api/public/stats
 */
router.get('/stats', async (req, res) => {
  try {
    // Get total user count (excluding deleted accounts)
    const [{ count: totalUsers }] = await db.select({ count: count() })
      .from(profiles)
      .where(isNull(profiles.deletedAt))

    // Get total matches count
    const [{ count: totalMatches }] = await db.select({ count: count() })
      .from(friendships)
      .where(eq(friendships.status, 'active'))

    // Get total messages count (optional - can be heavy on large databases)
    const [{ count: totalMessages }] = await db.select({ count: count() })
      .from(messages)

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
