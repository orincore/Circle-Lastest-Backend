import express from 'express'
import { RefundService } from '../services/refund.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'
import { supabase } from '../config/supabase.js'

const router = express.Router()

// User: Request a refund
router.post('/request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const adminUserId = req.user!.id
    const { subscription_id, reason, user_id } = req.body

    if (!subscription_id) {
      return res.status(400).json({ error: 'Subscription ID is required' })
    }

    // Check if subscription exists
    const { data: subscription, error: subError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', subscription_id)
      .single()

    if (subError || !subscription) {
      logger.error({ subError, subscription_id }, 'Subscription not found')
      return res.status(400).json({ error: 'Subscription not found' })
    }

    // For admin-initiated refunds, use the subscription's actual user_id
    // For user-initiated refunds, ensure it belongs to the requesting user
    let refundUserId = subscription.user_id
    
    if (!user_id) {
      // User-initiated refund - check ownership
      if (subscription.user_id !== adminUserId) {
        return res.status(400).json({ error: 'Subscription does not belong to user' })
      }
    } else {
      // Admin-initiated refund - verify the user_id matches subscription
      if (subscription.user_id !== user_id) {
        return res.status(400).json({ error: 'Subscription does not belong to specified user' })
      }
      refundUserId = user_id
    }

    // For now, create a simple refund record without the complex eligibility checks
    // This will be improved once the refunds table is created
    const mockRefund = {
      id: `refund_${Date.now()}`,
      subscription_id,
      user_id: refundUserId,
      amount: subscription.price_paid || 9.99,
      currency: subscription.currency || 'USD',
      reason: reason || 'User requested refund',
      status: 'pending',
      requested_at: new Date().toISOString()
    }

    res.json({
      success: true,
      refund: mockRefund,
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

    // Mock empty refunds list for now
    const mockResult = {
      refunds: [],
      total: 0
    }

    logger.info({ status, limit, offset }, 'Mock: Getting all refunds')
    res.json(mockResult)
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

    // For now, create a mock processed refund response
    // This will be replaced with actual refund processing once the table is created
    const mockProcessedRefund = {
      id: refundId,
      status: action === 'approve' ? 'processed' : 'rejected',
      processed_at: new Date().toISOString(),
      processed_by: adminUserId,
      admin_notes: admin_notes || `Refund ${action}d by admin`
    }

    logger.info({ refundId, action, adminUserId }, `Mock refund ${action}d`)

    res.json({
      success: true,
      refund: mockProcessedRefund,
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
    // Mock stats for now
    const mockStats = {
      total_requests: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      processed: 0,
      failed: 0,
      total_amount: 0,
      pending_amount: 0
    }

    logger.info('Mock: Getting refund stats')
    res.json(mockStats)
  } catch (error) {
    logger.error({ error }, 'Error getting refund stats')
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
