import express from 'express'
import { RefundService } from '../services/refund.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'

const router = express.Router()

// User: Request a refund
router.post('/request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { subscription_id, reason } = req.body

    if (!subscription_id) {
      return res.status(400).json({ error: 'Subscription ID is required' })
    }

    const refund = await RefundService.requestRefund(userId, subscription_id, reason)

    res.json({
      success: true,
      refund,
      message: 'Refund request submitted successfully. You will receive an email confirmation shortly.'
    })
  } catch (error: any) {
    logger.error({ error, userId: req.user!.id }, 'Error requesting refund')
    res.status(400).json({ 
      error: error.message || 'Failed to request refund'
    })
  }
})

// User: Get their refund requests
router.get('/my-requests', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const refunds = await RefundService.getUserRefunds(userId)

    res.json({
      refunds,
      total: refunds.length
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error getting user refunds')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// User: Check refund eligibility for a subscription
router.get('/eligibility/:subscriptionId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { subscriptionId } = req.params
    const isEligible = await RefundService.checkRefundEligibility(subscriptionId)

    res.json({
      subscription_id: subscriptionId,
      eligible: isEligible,
      message: isEligible 
        ? 'This subscription is eligible for refund'
        : 'This subscription is not eligible for refund. Refunds are only available within 7 days of purchase.'
    })
  } catch (error) {
    logger.error({ error, subscriptionId: req.params.subscriptionId }, 'Error checking refund eligibility')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Admin: Get all refund requests
router.get('/admin/all', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { status, limit = 50, offset = 0 } = req.query

    const result = await RefundService.getAllRefunds(
      status as string,
      parseInt(limit as string),
      parseInt(offset as string)
    )

    res.json(result)
  } catch (error) {
    logger.error({ error }, 'Error getting all refunds')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Admin: Process refund (approve/reject)
router.post('/admin/process/:refundId', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { refundId } = req.params
    const { action, admin_notes } = req.body
    const adminUserId = req.user!.id

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Action must be either "approve" or "reject"' })
    }

    const refund = await RefundService.processRefund(
      refundId,
      adminUserId,
      action,
      admin_notes
    )

    res.json({
      success: true,
      refund,
      message: `Refund ${action}d successfully`
    })
  } catch (error: any) {
    logger.error({ error, refundId: req.params.refundId }, 'Error processing refund')
    res.status(400).json({ 
      error: error.message || 'Failed to process refund'
    })
  }
})

// Admin: Get refund statistics
router.get('/admin/stats', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const stats = await RefundService.getRefundStats()
    res.json(stats)
  } catch (error) {
    logger.error({ error }, 'Error getting refund stats')
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
