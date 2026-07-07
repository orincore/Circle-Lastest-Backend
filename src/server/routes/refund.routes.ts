import express from 'express'
import { eq } from 'drizzle-orm'
import { RefundService } from '../services/refund.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'
import { db } from '../config/db.js'
import { userSubscriptions } from '../db/schema.js'

const router = express.Router()

// User: Request a refund
router.post('/request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const requesterId = req.user!.id
    const { subscription_id, reason, user_id } = req.body

    if (!subscription_id) {
      return res.status(400).json({ error: 'Subscription ID is required' })
    }

    const [subscription] = await db.select().from(userSubscriptions)
      .where(eq(userSubscriptions.id, subscription_id))
      .limit(1)

    if (!subscription) {
      logger.error({ subscription_id }, 'Subscription not found')
      return res.status(400).json({ error: 'Subscription not found' })
    }

    // For admin-initiated refunds (user_id provided), operate on that user's subscription.
    // For user-initiated refunds, the subscription must belong to the requester.
    if (!user_id) {
      if (subscription.userId !== requesterId) {
        return res.status(400).json({ error: 'Subscription does not belong to user' })
      }
    } else if (subscription.userId !== user_id) {
      return res.status(400).json({ error: 'Subscription does not belong to specified user' })
    }

    const refund = await RefundService.requestRefund(subscription.userId, subscription_id, reason)

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

// Admin: Get refunds for a specific user
router.get('/user/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { userId } = req.params
    const refunds = await RefundService.getUserRefunds(userId)

    res.json({
      refunds,
      total: refunds.length
    })
  } catch (error) {
    logger.error({ error, userId: req.params.userId }, 'Error getting user refunds')
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
    const { status, limit = '50', offset = '0' } = req.query
    const result = await RefundService.getAllRefunds(
      status && status !== 'all' ? String(status) : undefined,
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

    const refund = await RefundService.processRefund(refundId, adminUserId, action, admin_notes)

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

// Admin: Process payment for an approved refund (Razorpay only -- see RefundService.processPaymentRefund)
router.post('/admin/process-payment/:refundId', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { refundId } = req.params
    const refund = await RefundService.getRefundById(refundId)

    if (!refund) {
      return res.status(404).json({ error: 'Refund not found' })
    }

    if (refund.status !== 'approved') {
      return res.status(400).json({ error: 'Refund must be approved before processing payment' })
    }

    const paymentResult = await RefundService.processPaymentRefund(refund)

    res.json({
      success: true,
      paymentResult,
      message: 'Refund payment processed successfully'
    })
  } catch (error: any) {
    logger.error({ error, refundId: req.params.refundId }, 'Error processing refund payment')
    res.status(400).json({
      error: error.message || 'Failed to process refund payment'
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
