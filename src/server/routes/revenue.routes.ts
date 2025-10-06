import express from 'express'
import { RevenueService } from '../services/revenue.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'

const router = express.Router()

// Admin: Get overall revenue statistics
router.get('/admin/stats', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { days = 30 } = req.query
    const stats = await RevenueService.getRevenueStats(parseInt(days as string))

    res.json({
      success: true,
      stats
    })
  } catch (error) {
    logger.error({ error }, 'Error getting revenue stats')
    res.status(500).json({ error: 'Failed to load revenue statistics' })
  }
})

// Admin: Get revenue breakdown by plan type
router.get('/admin/by-plan', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { days = 30 } = req.query
    const planRevenue = await RevenueService.getRevenueByPlan(parseInt(days as string))

    res.json({
      success: true,
      planRevenue
    })
  } catch (error) {
    logger.error({ error }, 'Error getting revenue by plan')
    res.status(500).json({ error: 'Failed to load plan revenue data' })
  }
})

// Admin: Get monthly revenue trend
router.get('/admin/monthly-trend', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { months = 12 } = req.query
    const monthlyTrend = await RevenueService.getMonthlyRevenueTrend(parseInt(months as string))

    res.json({
      success: true,
      monthlyTrend
    })
  } catch (error) {
    logger.error({ error }, 'Error getting monthly revenue trend')
    res.status(500).json({ error: 'Failed to load monthly revenue trend' })
  }
})

// Admin: Get detailed revenue breakdown
router.get('/admin/breakdown', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { days = 30 } = req.query
    const breakdown = await RevenueService.getRevenueBreakdown(parseInt(days as string))

    res.json({
      success: true,
      breakdown
    })
  } catch (error) {
    logger.error({ error }, 'Error getting revenue breakdown')
    res.status(500).json({ error: 'Failed to load revenue breakdown' })
  }
})

// Admin: Get comprehensive revenue dashboard data
router.get('/admin/dashboard', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { days = 30, months = 12 } = req.query
    const daysNum = parseInt(days as string)
    const monthsNum = parseInt(months as string)

    // Get all data in parallel
    const [stats, planRevenue, monthlyTrend, breakdown] = await Promise.all([
      RevenueService.getRevenueStats(daysNum),
      RevenueService.getRevenueByPlan(daysNum),
      RevenueService.getMonthlyRevenueTrend(monthsNum),
      RevenueService.getRevenueBreakdown(daysNum)
    ])

    res.json({
      success: true,
      dashboard: {
        stats,
        planRevenue,
        monthlyTrend,
        breakdown,
        period: {
          days: daysNum,
          months: monthsNum
        }
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error getting revenue dashboard')
    res.status(500).json({ error: 'Failed to load revenue dashboard' })
  }
})

export default router
