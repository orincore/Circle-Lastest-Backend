import express from 'express'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { userSubscriptions, profiles } from '../db/schema.js'
import { SubscriptionService } from '../services/subscription.service.js'
import { requireAuth } from '../middleware/auth.js'
import { requireAdmin, type AdminRequest } from '../middleware/adminAuth.js'
import { logger } from '../config/logger.js'
import EmailService from '../services/emailService.js'

const router = express.Router()

const VALID_PLANS = ['monthly', 'yearly']
const VALID_STATUSES = ['active', 'cancelled', 'expired', 'grace_period', 'pending']

function formatSubscription(row: typeof userSubscriptions.$inferSelect & { user_email?: string | null; user_username?: string | null }) {
  return {
    id: row.id,
    user_id: row.userId,
    plan_type: row.planId,
    status: row.status,
    source: row.source,
    started_at: row.startedAt,
    expires_at: row.expiresAt,
    cancelled_at: row.cancelledAt,
    auto_renew: row.autoRenew,
    price_paid: row.amount !== null && row.amount !== undefined ? Number(row.amount) : null,
    currency: row.currency,
    payment_provider: row.source,
    external_subscription_id: row.appleOriginalTransactionId || row.googlePurchaseToken || row.razorpaySubscriptionId || null,
    user_email: row.user_email,
    user_username: row.user_username,
  }
}

// Get all subscriptions with user info (admin only)
router.get('/', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const rows = await db.select({
      sub: userSubscriptions,
      user_email: profiles.email,
      user_username: profiles.username,
    })
      .from(userSubscriptions)
      .leftJoin(profiles, eq(profiles.id, userSubscriptions.userId))
      .orderBy(desc(userSubscriptions.createdAt))

    const formattedSubscriptions = rows.map(row => formatSubscription({ ...row.sub, user_email: row.user_email, user_username: row.user_username }))

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

    if (plan_type && !VALID_PLANS.includes(plan_type)) {
      return res.status(400).json({ error: 'Invalid plan type' })
    }

    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    const updateData: Partial<typeof userSubscriptions.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    }
    if (plan_type) updateData.planId = plan_type
    if (status) updateData.status = status
    if (expires_at !== undefined) {
      updateData.expiresAt = expires_at ? new Date(expires_at).toISOString() : updateData.expiresAt
    }

    const [data] = await db.update(userSubscriptions)
      .set(updateData)
      .where(eq(userSubscriptions.id, subscriptionId))
      .returning()

    if (!data) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    if ((status === 'active' || plan_type) && data.status === 'active') {
      const [userProfile] = await db.select({ email: profiles.email, username: profiles.username })
        .from(profiles).where(eq(profiles.id, data.userId)).limit(1)

      if (userProfile?.email) {
        try {
          await EmailService.sendSponsoredSubscriptionEmail(
            userProfile.email,
            userProfile.username || 'User',
            data.planId,
            data.expiresAt
          )
          logger.info({ subscriptionId, userId: data.userId, email: userProfile.email, planType: data.planId }, 'Sponsored subscription email sent by admin update')
        } catch (emailError) {
          logger.error({ error: emailError, subscriptionId, userId: data.userId }, 'Failed to send sponsored subscription email on admin update')
        }
      }
    }

    logger.info({ subscriptionId, adminId: req.user!.id, changes: updateData }, 'Subscription updated by admin')

    res.json({
      message: 'Subscription updated successfully',
      subscription: formatSubscription(data)
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

    const [subscription] = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, subscriptionId)).limit(1)

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    if (subscription.status !== 'active') {
      return res.status(400).json({ error: 'Only active subscriptions can be cancelled' })
    }

    const [data] = await db.update(userSubscriptions)
      .set({ status: 'cancelled', autoRenew: false, cancelledAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(userSubscriptions.id, subscriptionId))
      .returning()

    const [userProfile] = await db.select({ email: profiles.email, username: profiles.username })
      .from(profiles).where(eq(profiles.id, subscription.userId)).limit(1)

    if (userProfile?.email) {
      try {
        await EmailService.sendSubscriptionCancellationEmail(
          userProfile.email,
          userProfile.username || 'User',
          subscription.planId,
          new Date().toISOString()
        )
        logger.info({ subscriptionId, userId: subscription.userId, email: userProfile.email }, 'Admin cancellation email sent')
      } catch (emailError) {
        logger.error({ error: emailError, subscriptionId, userId: subscription.userId }, 'Failed to send admin cancellation email')
      }
    }

    logger.info({ subscriptionId, adminId: req.user!.id, userId: subscription.userId }, 'Subscription cancelled by admin')

    res.json({
      message: 'Subscription cancelled successfully',
      subscription: formatSubscription(data)
    })
  } catch (error) {
    logger.error({ error, subscriptionId: req.params.subscriptionId }, 'Error cancelling subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create subscription (admin only) -- e.g. sponsored/promotional grants
router.post('/create', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      user_id,
      plan_type,
      expires_at,
      price_paid,
      currency = 'INR',
      source = 'web',
    } = req.body

    if (!user_id || !plan_type) {
      return res.status(400).json({ error: 'user_id and plan_type are required' })
    }

    if (!VALID_PLANS.includes(plan_type)) {
      return res.status(400).json({ error: 'Invalid plan type' })
    }

    const [userExists] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, user_id)).limit(1)

    if (!userExists) {
      return res.status(404).json({ error: 'User not found' })
    }

    const existing = await SubscriptionService.getUserSubscription(user_id)
    const expiresAtDate = expires_at ? new Date(expires_at) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const data = await SubscriptionService.createSubscription(
      user_id,
      plan_type,
      expiresAtDate,
      source,
      {},
      price_paid || 0,
      currency
    )

    if (existing) {
      logger.info({ userId: user_id }, 'Replaced existing subscription with admin-created one')
    }

    const [userProfile] = await db.select({ email: profiles.email, username: profiles.username })
      .from(profiles).where(eq(profiles.id, user_id)).limit(1)

    if (userProfile?.email) {
      try {
        await EmailService.sendSponsoredSubscriptionEmail(
          userProfile.email,
          userProfile.username || 'User',
          plan_type,
          expiresAtDate.toISOString()
        )
        logger.info({ subscriptionId: data.id, userId: user_id, email: userProfile.email }, 'Sponsored subscription email sent')
      } catch (emailError) {
        logger.error({ error: emailError, subscriptionId: data.id, userId: user_id }, 'Failed to send sponsored subscription email')
      }
    }

    logger.info({ subscriptionId: data.id, adminId: req.user!.id, userId: user_id, planType: plan_type }, 'Subscription created by admin')

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

    const [subscription] = await db.select().from(userSubscriptions).where(eq(userSubscriptions.id, subscriptionId)).limit(1)

    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' })
    }

    await db.delete(userSubscriptions).where(eq(userSubscriptions.id, subscriptionId))

    logger.warn({ subscriptionId, adminId: req.user!.id, userId: subscription.userId, planType: subscription.planId }, 'Subscription permanently deleted by admin')

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

    const rows = await db.select({
      sub: userSubscriptions,
      user_email: profiles.email,
      user_username: profiles.username,
    })
      .from(userSubscriptions)
      .leftJoin(profiles, eq(profiles.id, userSubscriptions.userId))
      .where(eq(userSubscriptions.userId, userId))
      .orderBy(desc(userSubscriptions.createdAt))

    const formattedSubscriptions = rows.map(row => formatSubscription({ ...row.sub, user_email: row.user_email, user_username: row.user_username }))

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
