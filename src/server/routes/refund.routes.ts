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

    // Create actual refund record in database
    const { data: refund, error: refundError } = await supabase
      .from('refunds')
      .insert({
        subscription_id,
        user_id: refundUserId,
        amount: subscription.price_paid || 9.99,
        currency: subscription.currency || 'USD',
        reason: reason || 'User requested refund',
        payment_provider: subscription.payment_provider,
        refund_method: 'original_payment_method'
      })
      .select()
      .single()

    if (refundError) {
      logger.error({ refundError, subscription_id }, 'Failed to create refund record')
      return res.status(500).json({ error: 'Failed to create refund request' })
    }

    // Send notification email to user
    try {
      const { data: userProfile } = await supabase
        .from('profiles')
        .select('email, username')
        .eq('id', refundUserId)
        .single()

      if (userProfile?.email) {
        const { default: EmailService } = await import('../services/emailService.js')
        await EmailService.sendRefundRequestConfirmation(
          userProfile.email,
          userProfile.username || 'User',
          subscription.plan_type,
          refund.amount,
          refund.currency,
          refund.id
        )
      }
    } catch (emailError) {
      logger.warn({ error: emailError, refundId: refund.id }, 'Failed to send refund confirmation email')
    }

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
    
    const { data, error } = await supabase
      .from('refunds')
      .select(`
        *,
        subscription:subscriptions(plan_type, started_at),
        processed_by_profile:profiles!refunds_processed_by_fkey(username)
      `)
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })

    if (error) {
      logger.error({ error, userId }, 'Error getting user refunds')
      return res.status(500).json({ error: 'Failed to load refunds' })
    }

    res.json({
      refunds: data || [],
      total: data?.length || 0
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
    
    const { data, error } = await supabase
      .from('refunds')
      .select(`
        *,
        subscription:subscriptions(plan_type, started_at),
        processed_by_profile:profiles!refunds_processed_by_fkey(username)
      `)
      .eq('user_id', userId)
      .order('requested_at', { ascending: false })

    if (error) {
      logger.error({ error, userId }, 'Error getting user refunds')
      return res.status(500).json({ error: 'Failed to load refunds' })
    }

    res.json({
      refunds: data || [],
      total: data?.length || 0
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
    const { status, limit = 50, offset = 0 } = req.query

    let query = supabase
      .from('refunds')
      .select(`
        *,
        subscription:subscriptions(plan_type, started_at, external_subscription_id),
        user:profiles!refunds_user_id_fkey(username, email),
        processed_by_profile:profiles!refunds_processed_by_fkey(username)
      `, { count: 'exact' })
      .order('requested_at', { ascending: false })

    if (status && status !== 'all') {
      query = query.eq('status', status)
    }

    const { data, error, count } = await query
      .range(parseInt(offset as string), parseInt(offset as string) + parseInt(limit as string) - 1)

    if (error) {
      logger.error({ error }, 'Error getting all refunds')
      return res.status(500).json({ error: 'Failed to load refunds' })
    }

    res.json({
      refunds: data || [],
      total: count || 0
    })
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

    // Get the refund record
    const { data: refund, error: fetchError } = await supabase
      .from('refunds')
      .select(`
        *,
        subscription:subscriptions(*),
        user:profiles!refunds_user_id_fkey(username, email)
      `)
      .eq('id', refundId)
      .single()

    if (fetchError || !refund) {
      return res.status(404).json({ error: 'Refund not found' })
    }

    if (refund.status !== 'pending') {
      return res.status(400).json({ error: 'Refund has already been processed' })
    }

    const newStatus = action === 'approve' ? 'processed' : 'rejected'

    // Update refund status
    const { data: updatedRefund, error: updateError } = await supabase
      .from('refunds')
      .update({
        status: newStatus,
        processed_at: new Date().toISOString(),
        processed_by: adminUserId,
        admin_notes: admin_notes || `Refund ${action}d by admin`
      })
      .eq('id', refundId)
      .select()
      .single()

    if (updateError) {
      logger.error({ updateError, refundId }, 'Failed to update refund status')
      return res.status(500).json({ error: 'Failed to process refund' })
    }

    // Send notification email to user
    try {
      if (refund.user?.email) {
        const { default: EmailService } = await import('../services/emailService.js')
        if (action === 'approve') {
          await EmailService.sendRefundApprovalEmail(
            refund.user.email,
            refund.user.username || 'User',
            refund.subscription.plan_type,
            refund.amount,
            refund.currency
          )
        } else {
          await EmailService.sendRefundRejectionEmail(
            refund.user.email,
            refund.user.username || 'User',
            refund.subscription.plan_type,
            admin_notes || 'No reason provided'
          )
        }
      }
    } catch (emailError) {
      logger.warn({ error: emailError, refundId }, 'Failed to send refund status email')
    }

    logger.info({ refundId, action, adminUserId }, `Refund ${action}d successfully`)

    res.json({
      success: true,
      refund: updatedRefund,
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
    const { data, error } = await supabase.rpc('get_refund_stats')

    if (error) {
      logger.error({ error }, 'Error getting refund stats')
      return res.status(500).json({ error: 'Failed to load refund statistics' })
    }

    res.json(data || {
      total_requests: 0,
      pending: 0,
      approved: 0,
      rejected: 0,
      processed: 0,
      failed: 0,
      total_amount: 0,
      pending_amount: 0
    })
  } catch (error) {
    logger.error({ error }, 'Error getting refund stats')
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
