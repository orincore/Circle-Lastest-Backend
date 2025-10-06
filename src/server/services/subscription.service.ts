import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'

export interface Subscription {
  id: string
  user_id: string
  plan_type: 'free' | 'premium' | 'premium_plus'
  status: 'active' | 'cancelled' | 'expired' | 'pending'
  started_at: Date
  expires_at?: Date
  payment_provider?: string
  external_subscription_id?: string
  price_paid?: number
  currency: string
  auto_renew: boolean
  cancelled_at?: Date
}

export interface DailyMatchLimit {
  id: string
  user_id: string
  date: string
  matches_made: number
}

export class SubscriptionService {
  // Get user's current subscription (active or any status)
  static async getUserSubscription(userId: string): Promise<Subscription | null> {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error
      }
      
      return data || null
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user subscription')
      throw error
    }
  }

  // Get user's active subscription only
  static async getActiveSubscription(userId: string): Promise<Subscription | null> {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single()
      
      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        throw error
      }
      
      return data || null
    } catch (error) {
      logger.error({ error, userId }, 'Error getting active subscription')
      throw error
    }
  }

  // Check if user is premium
  static async isPremiumUser(userId: string): Promise<boolean> {
    try {
      const subscription = await this.getActiveSubscription(userId)
      if (!subscription) return false
      
      // Check if subscription is premium and not expired
      if (subscription.plan_type === 'free') return false
      
      if (subscription.expires_at && new Date() > subscription.expires_at) {
        // Subscription expired, update status
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
  static async getUserPlan(userId: string): Promise<'free' | 'premium' | 'premium_plus'> {
    try {
      const subscription = await this.getActiveSubscription(userId)
      if (!subscription) return 'free'
      
      // Check if expired
      if (subscription.expires_at && new Date() > subscription.expires_at) {
        await this.expireSubscription(userId)
        return 'free'
      }
      
      return subscription.plan_type
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
      const { data, error } = await supabase
        .from('daily_match_limits')
        .select('matches_made')
        .eq('user_id', userId)
        .eq('date', today)
        .single()
      
      if (error && error.code !== 'PGRST116') {
        throw error
      }
      
      const matchesUsed = data?.matches_made || 0
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
      
      // Try to update existing record first
      const { data: existing } = await supabase
        .from('daily_match_limits')
        .select('matches_made')
        .eq('user_id', userId)
        .eq('date', today)
        .single()
      
      if (existing) {
        // Update existing record
        const { error } = await supabase
          .from('daily_match_limits')
          .update({ 
            matches_made: existing.matches_made + 1,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .eq('date', today)
        
        if (error) throw error
      } else {
        // Insert new record
        const { error } = await supabase
          .from('daily_match_limits')
          .insert({
            user_id: userId,
            date: today,
            matches_made: 1
          })
        
        if (error) throw error
      }
      
      logger.info({ userId, date: today }, 'Incremented daily match count')
    } catch (error) {
      logger.error({ error, userId }, 'Error incrementing daily matches')
      throw error
    }
  }

  // Create or update subscription
  static async createSubscription(
    userId: string,
    planType: 'premium' | 'premium_plus',
    expiresAt: Date,
    paymentProvider?: string,
    externalSubscriptionId?: string,
    pricePaid?: number,
    currency = 'USD'
  ): Promise<Subscription> {
    try {
      // First, try to get existing subscription
      const existingSubscription = await this.getUserSubscription(userId)
      
      let data: Subscription
      
      if (existingSubscription) {
        // Update existing subscription
        const { data: updatedData, error } = await supabase
          .from('subscriptions')
          .update({
            plan_type: planType,
            status: 'active',
            expires_at: expiresAt.toISOString(),
            payment_provider: paymentProvider,
            external_subscription_id: externalSubscriptionId,
            price_paid: pricePaid,
            currency,
            updated_at: new Date().toISOString()
          })
          .eq('user_id', userId)
          .select()
          .single()
        
        if (error) throw error
        data = updatedData
        logger.info({ userId, planType }, 'Updated existing subscription')
      } else {
        // Create new subscription
        const { data: newData, error } = await supabase
          .from('subscriptions')
          .insert({
            user_id: userId,
            plan_type: planType,
            status: 'active',
            started_at: new Date().toISOString(),
            expires_at: expiresAt.toISOString(),
            payment_provider: paymentProvider,
            external_subscription_id: externalSubscriptionId,
            price_paid: pricePaid,
            currency,
            auto_renew: true
          })
          .select()
          .single()
        
        if (error) throw error
        data = newData
        logger.info({ userId, planType }, 'Created new subscription')
      }

      // Update profiles table
      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          subscription_plan: planType,
          premium_expires_at: expiresAt.toISOString()
        })
        .eq('id', userId)
      
      if (profileError) throw profileError

      logger.info({ userId, planType, expiresAt }, 'Created/updated subscription')
      return data
    } catch (error) {
      logger.error({ error, userId, planType }, 'Error creating subscription')
      throw error
    }
  }

  // Cancel subscription
  static async cancelSubscription(userId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('subscriptions')
        .update({
          status: 'cancelled',
          cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('status', 'active')
      
      if (error) throw error

      const { error: profileError } = await supabase
        .from('profiles')
        .update({
          subscription_plan: 'free',
          premium_expires_at: null
        })
        .eq('id', userId)
      
      if (profileError) throw profileError

      logger.info({ userId }, 'Cancelled subscription')
    } catch (error) {
      logger.error({ error, userId }, 'Error cancelling subscription')
      throw error
    }
  }

  // Expire a subscription (mark as expired)
  static async expireSubscription(userId: string): Promise<void> {
    try {
      await supabase
        .from('subscriptions')
        .update({ 
          status: 'expired',
          expired_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('status', 'active')
      
      logger.info({ userId }, 'Subscription expired')

      logger.info({ userId }, 'Expired subscription')
    } catch (error) {
      logger.error({ error, userId }, 'Error expiring subscription')
      throw error
    }
  }

  // Get subscription stats for admin
  static async getSubscriptionStats(): Promise<{
    total: number
    free: number
    premium: number
    premium_plus: number
    active: number
    expired: number
    cancelled: number
  }> {
    try {
      const { data, error } = await supabase
        .from('subscriptions')
        .select('plan_type, status')
      
      if (error) throw error
      
      const stats = {
        total: data.length,
        free: data.filter(s => s.plan_type === 'free').length,
        premium: data.filter(s => s.plan_type === 'premium').length,
        premium_plus: data.filter(s => s.plan_type === 'premium_plus').length,
        active: data.filter(s => s.status === 'active').length,
        expired: data.filter(s => s.status === 'expired').length,
        cancelled: data.filter(s => s.status === 'cancelled').length
      }
      
      return stats
    } catch (error) {
      logger.error({ error }, 'Error getting subscription stats')
      throw error
    }
  }

  // Clean up expired subscriptions (run as cron job)
  static async cleanupExpiredSubscriptions(): Promise<number> {
    try {
      // Get expired subscriptions
      const { data: expired, error: selectError } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('status', 'active')
        .lt('expires_at', new Date().toISOString())
      
      if (selectError) throw selectError
      
      if (expired && expired.length > 0) {
        // Update subscriptions to expired
        const { error: updateError } = await supabase
          .from('subscriptions')
          .update({
            status: 'expired',
            updated_at: new Date().toISOString()
          })
          .eq('status', 'active')
          .lt('expires_at', new Date().toISOString())
        
        if (updateError) throw updateError
        
        // Update profiles table for expired subscriptions
        const userIds = expired.map((row: any) => row.user_id)
        const { error: profileError } = await supabase
          .from('profiles')
          .update({
            subscription_plan: 'free',
            premium_expires_at: null
          })
          .in('id', userIds)
        
        if (profileError) throw profileError
      }

      logger.info({ count: expired?.length || 0 }, 'Cleaned up expired subscriptions')
      return expired?.length || 0
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
