import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { userSubscriptions, dailyMatchLimits, profiles } from '../db/schema.js'
import { logger } from '../config/logger.js'

export type PlanId = 'monthly' | 'yearly'
export type SubscriptionSource = 'ios' | 'android' | 'web'
export type SubscriptionStatus = 'active' | 'cancelled' | 'expired' | 'grace_period' | 'pending'

export interface Subscription {
  id: string
  user_id: string
  plan_id: PlanId
  status: SubscriptionStatus
  source: SubscriptionSource
  started_at: Date
  expires_at: Date
  auto_renew: boolean
  cancelled_at?: Date
  amount?: number
  currency: string
  apple_original_transaction_id?: string | null
  apple_transaction_id?: string | null
  google_purchase_token?: string | null
  google_order_id?: string | null
  razorpay_subscription_id?: string | null
  razorpay_customer_id?: string | null
}

export interface DailyMatchLimit {
  id: string
  user_id: string
  date: string
  matches_made: number
}

function rowToSubscription(row: typeof userSubscriptions.$inferSelect): Subscription {
  return {
    id: row.id,
    user_id: row.userId,
    plan_id: row.planId as PlanId,
    status: row.status as SubscriptionStatus,
    source: row.source as SubscriptionSource,
    started_at: new Date(row.startedAt),
    expires_at: new Date(row.expiresAt),
    auto_renew: row.autoRenew,
    cancelled_at: row.cancelledAt ? new Date(row.cancelledAt) : undefined,
    amount: row.amount !== null && row.amount !== undefined ? Number(row.amount) : undefined,
    currency: row.currency || 'INR',
    apple_original_transaction_id: row.appleOriginalTransactionId,
    apple_transaction_id: row.appleTransactionId,
    google_purchase_token: row.googlePurchaseToken,
    google_order_id: row.googleOrderId,
    razorpay_subscription_id: row.razorpaySubscriptionId,
    razorpay_customer_id: row.razorpayCustomerId,
  }
}

export class SubscriptionService {
  // Get user's current subscription row, if any (one row per user, any status)
  static async getUserSubscription(userId: string): Promise<Subscription | null> {
    try {
      const [row] = await db.select().from(userSubscriptions)
        .where(eq(userSubscriptions.userId, userId))
        .limit(1)

      return row ? rowToSubscription(row) : null
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user subscription')
      throw error
    }
  }

  // Get user's subscription only if status is exactly 'active'
  static async getActiveSubscription(userId: string): Promise<Subscription | null> {
    try {
      const [row] = await db.select().from(userSubscriptions)
        .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 'active')))
        .limit(1)

      return row ? rowToSubscription(row) : null
    } catch (error) {
      logger.error({ error, userId }, 'Error getting active subscription')
      throw error
    }
  }

  // Check if user is premium (active or cancelled-but-not-yet-expired)
  static async isPremiumUser(userId: string): Promise<boolean> {
    try {
      const subscription = await this.getUserSubscription(userId)
      if (!subscription) return false

      if (!['active', 'cancelled', 'grace_period'].includes(subscription.status)) {
        return false
      }

      if (subscription.expires_at && new Date() > subscription.expires_at) {
        await this.expireSubscription(userId)
        return false
      }

      return true
    } catch (error) {
      logger.error({ error, userId }, 'Error checking premium status')
      return false
    }
  }

  // Get user's subscription plan
  static async getUserPlan(userId: string): Promise<'free' | PlanId> {
    try {
      const isPremium = await this.isPremiumUser(userId)
      if (!isPremium) return 'free'

      const subscription = await this.getUserSubscription(userId)
      return subscription?.plan_id || 'free'
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user plan')
      return 'free'
    }
  }

  // Check daily match limit for free users
  static async checkDailyMatchLimit(userId: string): Promise<{ canMatch: boolean; matchesUsed: number; limit: number }> {
    try {
      const isPremium = await this.isPremiumUser(userId)

      // Premium users have unlimited matches
      if (isPremium) {
        return { canMatch: true, matchesUsed: 0, limit: -1 }
      }

      // Free users have 3 matches per day
      const today = new Date().toISOString().split('T')[0]
      const [row] = await db.select({ matchesMade: dailyMatchLimits.matchesMade }).from(dailyMatchLimits)
        .where(and(eq(dailyMatchLimits.userId, userId), eq(dailyMatchLimits.date, today)))
        .limit(1)

      const matchesUsed = row?.matchesMade || 0
      const limit = 3

      return {
        canMatch: matchesUsed < limit,
        matchesUsed,
        limit
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error checking daily match limit')
      return { canMatch: false, matchesUsed: 0, limit: 3 }
    }
  }

  // Increment daily match count
  static async incrementDailyMatches(userId: string): Promise<void> {
    try {
      const today = new Date().toISOString().split('T')[0]

      await db.insert(dailyMatchLimits)
        .values({ userId, date: today, matchesMade: 1 })
        .onConflictDoUpdate({
          target: [dailyMatchLimits.userId, dailyMatchLimits.date],
          set: {
            matchesMade: sql`${dailyMatchLimits.matchesMade} + 1`,
            updatedAt: new Date().toISOString(),
          }
        })

      logger.info({ userId, date: today }, 'Incremented daily match count')
    } catch (error) {
      logger.error({ error, userId }, 'Error incrementing daily matches')
      throw error
    }
  }

  // Create or update the user's subscription (used by all three purchase sources)
  static async createSubscription(
    userId: string,
    planId: PlanId,
    expiresAt: Date,
    source: SubscriptionSource,
    externalIds: {
      appleOriginalTransactionId?: string
      appleTransactionId?: string
      googlePurchaseToken?: string
      googleOrderId?: string
      razorpaySubscriptionId?: string
      razorpayCustomerId?: string
    } = {},
    amount?: number,
    currency = 'INR'
  ): Promise<Subscription> {
    try {
      const existing = await this.getUserSubscription(userId)
      const nowIso = new Date().toISOString()

      const values = {
        planId,
        status: 'active' as const,
        source,
        expiresAt: expiresAt.toISOString(),
        autoRenew: true,
        cancelledAt: null,
        appleOriginalTransactionId: externalIds.appleOriginalTransactionId ?? null,
        appleTransactionId: externalIds.appleTransactionId ?? null,
        googlePurchaseToken: externalIds.googlePurchaseToken ?? null,
        googleOrderId: externalIds.googleOrderId ?? null,
        razorpaySubscriptionId: externalIds.razorpaySubscriptionId ?? null,
        razorpayCustomerId: externalIds.razorpayCustomerId ?? null,
        amount: amount !== undefined ? String(amount) : null,
        currency,
        updatedAt: nowIso,
      }

      let row: typeof userSubscriptions.$inferSelect
      if (existing) {
        const [updated] = await db.update(userSubscriptions)
          .set(values)
          .where(eq(userSubscriptions.userId, userId))
          .returning()
        row = updated
        logger.info({ userId, planId }, 'Updated existing subscription')
      } else {
        const [created] = await db.insert(userSubscriptions)
          .values({ userId, startedAt: nowIso, ...values })
          .returning()
        row = created
        logger.info({ userId, planId }, 'Created new subscription')
      }

      await db.update(profiles)
        .set({
          subscriptionPlan: planId,
          premiumExpiresAt: expiresAt.toISOString(),
        })
        .where(eq(profiles.id, userId))

      logger.info({ userId, planId, expiresAt }, 'Created/updated subscription')
      return rowToSubscription(row)
    } catch (error) {
      logger.error({ error, userId, planId }, 'Error creating subscription')
      throw error
    }
  }

  // Cancel subscription (retains access until expiry; auto_renew turned off)
  static async cancelSubscription(userId: string): Promise<void> {
    try {
      await db.update(userSubscriptions)
        .set({
          status: 'cancelled',
          autoRenew: false,
          cancelledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 'active')))

      logger.info({ userId }, 'Cancelled subscription')
    } catch (error) {
      logger.error({ error, userId }, 'Error cancelling subscription')
      throw error
    }
  }

  // Expire a subscription (mark as expired, reset profile display fields)
  static async expireSubscription(userId: string): Promise<void> {
    try {
      await db.update(userSubscriptions)
        .set({
          status: 'expired',
          updatedAt: new Date().toISOString(),
        })
        .where(and(eq(userSubscriptions.userId, userId), inArray(userSubscriptions.status, ['active', 'cancelled', 'grace_period'])))

      await db.update(profiles)
        .set({ subscriptionPlan: 'free', premiumExpiresAt: null })
        .where(eq(profiles.id, userId))

      logger.info({ userId }, 'Expired subscription')
    } catch (error) {
      logger.error({ error, userId }, 'Error expiring subscription')
      throw error
    }
  }

  // Get subscription stats for admin
  static async getSubscriptionStats(): Promise<{
    total: number
    monthly: number
    yearly: number
    active: number
    expired: number
    cancelled: number
  }> {
    try {
      const rows = await db.select({
        planId: userSubscriptions.planId,
        status: userSubscriptions.status,
      }).from(userSubscriptions)

      return {
        total: rows.length,
        monthly: rows.filter(s => s.planId === 'monthly').length,
        yearly: rows.filter(s => s.planId === 'yearly').length,
        active: rows.filter(s => s.status === 'active').length,
        expired: rows.filter(s => s.status === 'expired').length,
        cancelled: rows.filter(s => s.status === 'cancelled').length,
      }
    } catch (error) {
      logger.error({ error }, 'Error getting subscription stats')
      throw error
    }
  }

  // Clean up expired subscriptions (run as cron job)
  static async cleanupExpiredSubscriptions(): Promise<number> {
    try {
      const expired = await db.select({ userId: userSubscriptions.userId }).from(userSubscriptions)
        .where(and(eq(userSubscriptions.status, 'active'), lt(userSubscriptions.expiresAt, new Date().toISOString())))

      if (expired.length > 0) {
        await db.update(userSubscriptions)
          .set({ status: 'expired', updatedAt: new Date().toISOString() })
          .where(and(eq(userSubscriptions.status, 'active'), lt(userSubscriptions.expiresAt, new Date().toISOString())))

        const userIds = expired.map(row => row.userId)
        await db.update(profiles)
          .set({ subscriptionPlan: 'free', premiumExpiresAt: null })
          .where(inArray(profiles.id, userIds))
      }

      logger.info({ count: expired.length }, 'Cleaned up expired subscriptions')
      return expired.length
    } catch (error) {
      logger.error({ error }, 'Error cleaning up expired subscriptions')
      throw error
    }
  }
}

// Subscription middleware for route protection
export const requirePremium = async (req: any, res: any, next: any) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const isPremium = await SubscriptionService.isPremiumUser(userId)
    if (!isPremium) {
      return res.status(403).json({
        error: 'Premium subscription required',
        upgrade_required: true,
        current_plan: 'free'
      })
    }

    next()
  } catch (error) {
    logger.error({ error }, 'Error in requirePremium middleware')
    res.status(500).json({ error: 'Internal server error' })
  }
}

// Match limit middleware
export const checkMatchLimit = async (req: any, res: any, next: any) => {
  try {
    const userId = req.user?.id
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' })
    }

    const { canMatch, matchesUsed, limit } = await SubscriptionService.checkDailyMatchLimit(userId)
    if (!canMatch) {
      return res.status(429).json({
        error: 'Daily match limit reached',
        matches_used: matchesUsed,
        limit,
        upgrade_required: true,
        message: 'Upgrade to premium for unlimited matches'
      })
    }

    // Add match info to request for use in route handler
    req.matchInfo = { matchesUsed, limit }
    next()
  } catch (error) {
    logger.error({ error }, 'Error in checkMatchLimit middleware')
    res.status(500).json({ error: 'Internal server error' })
  }
}
