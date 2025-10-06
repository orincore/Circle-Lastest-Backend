import express from 'express'
import { SubscriptionService } from '../services/subscription.service.js'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin, type AdminRequest, logAdminAction } from '../middleware/adminAuth.js'
import { logger } from '../config/logger.js'
import { supabase } from '../config/supabase.js'
import EmailService from '../services/emailService.js'

const router = express.Router()

// Get all subscriptions with user info (admin only)
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        *,
        profiles:user_id (
          email,
          username
        )
      `)
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    // Format the response to include user info at the top level
    const formattedSubscriptions = subscriptions.map(sub => ({
      ...sub,
      user_email: sub.profiles?.email,
      user_username: sub.profiles?.username
    }))

    res.json({
      subscriptions: formattedSubscriptions,
      total: formattedSubscriptions.length
    })
  } catch (error) {
    logger.error({ error }, 'Error fetching subscriptions for admin')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get subscription statistics (admin only)
router.get('/stats', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const stats = await SubscriptionService.getSubscriptionStats()
    res.json(stats)
  } catch (error) {
    logger.error({ error }, 'Error fetching subscription stats')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update subscription (admin only)
router.put('/:subscriptionId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { subscriptionId } = req.params
    const { plan_type, status, expires_at } = req.body

    // Validate input
    const validPlans = ['free', 'premium', 'premium_plus']
    const validStatuses = ['active', 'cancelled', 'expired', 'pending']

    if (plan_type && !validPlans.includes(plan_type)) {
      return res.status(400).json({ error: 'Invalid plan type' })
    }

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    // Build update object
    const updateData: any = {}
    if (plan_type) updateData.plan_type = plan_type
    if (status) updateData.status = status
    if (expires_at !== undefined) {
      updateData.expires_at = expires_at ? new Date(expires_at).toISOString() : null
    }
    updateData.updated_at = new Date().toISOString()

    // Update subscription
    const { data, error } = await supabase
      .from('subscriptions')
      .update(updateData)
      .eq('id', subscriptionId)
      .select()
      .single()

    if (error) {
      throw error
    }

    if (!data) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    // Send sponsored subscription email if status changed to active or plan upgraded
    if ((status === 'active' || plan_type) && data.status === 'active') {
      // Get user details for email
      const { data: userProfile, error: profileError } = await supabase
        .from('profiles')
        .select('email, username')
        .eq('id', data.user_id)
        .single()

      if (userProfile && userProfile.email) {
        console.log('📧 Attempting to send sponsored subscription email...')
        try {
          await EmailService.sendSponsoredSubscriptionEmail(
            userProfile.email,
            userProfile.username || 'User',
            data.plan_type,
            data.expires_at
          )
          logger.info({ 
            subscriptionId,
            userId: data.user_id,
            email: userProfile.email,
            planType: data.plan_type
          }, 'Sponsored subscription email sent by admin update')
        } catch (emailError) {
          logger.error({ 
            error: emailError,
            subscriptionId,
            userId: data.user_id
          }, 'Failed to send sponsored subscription email on admin update')
          // Don't fail the update if email fails
        }
      }
    }

    logger.info({ 
      subscriptionId, 
      adminId: req.user!.id, 
      changes: updateData 
    }, 'Subscription updated by admin')

    res.json({
      message: 'Subscription updated successfully',
      subscription: data
    })
  } catch (error) {
    logger.error({ error, subscriptionId: req.params.subscriptionId }, 'Error updating subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Cancel subscription (admin only)
router.post('/:subscriptionId/cancel', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { subscriptionId } = req.params

    // Get subscription details first
    const { data: subscription, error: fetchError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .single()

    if (fetchError || !subscription) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    if (subscription.status !== 'active') {
      return res.status(400).json({ error: 'Only active subscriptions can be cancelled' })
    }

    // Cancel the subscription
    const { data, error } = await supabase
      .from('subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', subscriptionId)
      .select()
      .single()

    if (error) {
      throw error
    }

    // Get user details for email
    const { data: userProfile, error: profileError } = await supabase
      .from('profiles')
      .select('email, username')
      .eq('id', subscription.user_id)
      .single()

    if (userProfile && userProfile.email) {
      // Send cancellation email
      try {
        await EmailService.sendSubscriptionCancellationEmail(
          userProfile.email,
          userProfile.username || 'User',
          subscription.plan_type,
          new Date().toISOString()
        )
        logger.info({ 
          subscriptionId,
          userId: subscription.user_id,
          email: userProfile.email
        }, 'Admin cancellation email sent')
      } catch (emailError) {
        logger.error({ 
          error: emailError,
          subscriptionId,
          userId: subscription.user_id
        }, 'Failed to send admin cancellation email')
        // Don't fail the cancellation if email fails
      }
    }

    logger.info({ 
      subscriptionId, 
      adminId: req.user!.id,
      userId: subscription.user_id 
    }, 'Subscription cancelled by admin')

    res.json({
      message: 'Subscription cancelled successfully',
      subscription: data
    })
  } catch (error) {
    logger.error({ error, subscriptionId: req.params.subscriptionId }, 'Error cancelling subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create subscription (admin only)
router.post('/create', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { 
      user_id, 
      plan_type, 
      expires_at, 
      price_paid, 
      currency = 'USD',
      payment_provider = 'admin_created'
    } = req.body

    // Validate required fields
    if (!user_id || !plan_type) {
      return res.status(400).json({ error: 'user_id and plan_type are required' })
    }

    const validPlans = ['free', 'premium', 'premium_plus']
    if (!validPlans.includes(plan_type)) {
      return res.status(400).json({ error: 'Invalid plan type' })
    }

    // Check if user exists
    const { data: userExists, error: userError } = await supabase
      .from('profiles')
      .select('id')
      .eq('id', user_id)
      .single()

    if (userError || !userExists) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Cancel any existing active subscriptions for this user
    await supabase
      .from('subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('user_id', user_id)
      .eq('status', 'active')

    // Create new subscription
    const subscriptionData = {
      user_id,
      plan_type,
      status: 'active',
      started_at: new Date().toISOString(),
      expires_at: expires_at ? new Date(expires_at).toISOString() : null,
      price_paid: price_paid || 0,
      currency,
      payment_provider,
      auto_renew: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }

    const { data, error } = await supabase
      .from('subscriptions')
      .insert(subscriptionData)
      .select()
      .single()

    if (error) {
      throw error
    }

    // Get user details for email
    const { data: userProfile, error: profileError } = await supabase
      .from('profiles')
      .select('email, username')
      .eq('id', user_id)
      .single()

    if (userProfile && userProfile.email) {
      // Send sponsored subscription email
      try {
        await EmailService.sendSponsoredSubscriptionEmail(
          userProfile.email,
          userProfile.username || 'User',
          plan_type,
          expires_at ? new Date(expires_at).toISOString() : undefined
        )
        logger.info({ 
          subscriptionId: data.id,
          userId: user_id,
          email: userProfile.email
        }, 'Sponsored subscription email sent')
      } catch (emailError) {
        logger.error({ 
          error: emailError,
          subscriptionId: data.id,
          userId: user_id
        }, 'Failed to send sponsored subscription email')
        // Don't fail the subscription creation if email fails
      }
    }

    logger.info({ 
      subscriptionId: data.id,
      adminId: req.user!.id,
      userId: user_id,
      planType: plan_type
    }, 'Subscription created by admin')

    res.status(201).json({
      message: 'Subscription created successfully',
      subscription: data
    })
  } catch (error) {
    logger.error({ error }, 'Error creating subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Delete subscription (admin only) - permanent deletion
router.delete('/:subscriptionId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { subscriptionId } = req.params

    // Get subscription details first for logging
    const { data: subscription, error: fetchError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('id', subscriptionId)
      .single()

    if (fetchError || !subscription) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    // Delete the subscription
    const { error } = await supabase
      .from('subscriptions')
      .delete()
      .eq('id', subscriptionId)

    if (error) {
      throw error
    }

    logger.warn({ 
      subscriptionId, 
      adminId: req.user!.id,
      userId: subscription.user_id,
      planType: subscription.plan_type
    }, 'Subscription permanently deleted by admin')

    res.json({
      message: 'Subscription deleted successfully'
    })
  } catch (error) {
    logger.error({ error, subscriptionId: req.params.subscriptionId }, 'Error deleting subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get subscription history for a user (admin only)
router.get('/user/:userId/history', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params

    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        *,
        profiles:user_id (
          email,
          username
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error) {
      throw error
    }

    const formattedSubscriptions = subscriptions.map(sub => ({
      ...sub,
      user_email: sub.profiles?.email,
      user_username: sub.profiles?.username
    }))

    res.json({
      subscriptions: formattedSubscriptions,
      userId,
      total: formattedSubscriptions.length
    })
  } catch (error) {
    logger.error({ error, userId: req.params.userId }, 'Error fetching user subscription history')
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
