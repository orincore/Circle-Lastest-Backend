import { supabase } from '../../config/supabase.js'
import { logger } from '../../config/logger.js'

export interface ProactiveAlert {
  type: 'payment_failure' | 'subscription_expiry' | 'low_engagement' | 'technical_issue' | 'feature_confusion'
  severity: 'low' | 'medium' | 'high' | 'critical'
  userId: string
  message: string
  suggestedAction: string
  preventiveMessage?: string
  timeframe: 'immediate' | 'within_24h' | 'within_week'
}

export interface UserBehaviorPattern {
  userId: string
  loginFrequency: number
  lastActive: Date
  featureUsage: Record<string, number>
  supportTickets: number
  subscriptionStatus: string
  paymentIssues: number
  engagementScore: number
}

export class ProactiveSupportService {
  // Monitor user behavior and detect potential issues
  static async detectPotentialIssues(userId: string): Promise<ProactiveAlert[]> {
    try {
      const alerts: ProactiveAlert[] = []
      
      // Get user behavior data
      const behaviorPattern = await this.getUserBehaviorPattern(userId)
      
      // Check for various issue types
      alerts.push(...await this.checkPaymentIssues(userId, behaviorPattern))
      alerts.push(...await this.checkSubscriptionIssues(userId, behaviorPattern))
      alerts.push(...await this.checkEngagementIssues(userId, behaviorPattern))
      alerts.push(...await this.checkTechnicalIssues(userId, behaviorPattern))
      alerts.push(...await this.checkFeatureConfusion(userId, behaviorPattern))
      
      return alerts.filter(alert => alert !== null)
    } catch (error) {
      logger.error({ error, userId }, 'Error detecting proactive issues')
      return []
    }
  }

  // Get comprehensive user behavior pattern
  private static async getUserBehaviorPattern(userId: string): Promise<UserBehaviorPattern> {
    try {
      // Get user profile and subscription
      const { data: profile } = await supabase
        .from('profiles')
        .select('last_seen, created_at')
        .eq('id', userId)
        .single()

      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('status, plan_type, started_at, cancelled_at')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      // Get recent activity metrics
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      
      // Count logins (approximate from last_seen updates)
      const { count: loginCount } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .eq('id', userId)
        .gte('last_seen', thirtyDaysAgo.toISOString())

      // Count support interactions
      const { count: supportCount } = await supabase
        .from('ai_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString())

      // Count matches and messages (engagement)
      const { count: matchCount } = await supabase
        .from('matches')
        .select('*', { count: 'exact', head: true })
        .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
        .gte('created_at', thirtyDaysAgo.toISOString())

      const { count: messageCount } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('sender_id', userId)
        .gte('created_at', thirtyDaysAgo.toISOString())

      // Calculate engagement score
      const daysSinceJoin = Math.floor((Date.now() - new Date(profile?.created_at || Date.now()).getTime()) / (1000 * 60 * 60 * 24))
      const engagementScore = this.calculateEngagementScore(
        loginCount || 0,
        matchCount || 0,
        messageCount || 0,
        daysSinceJoin
      )

      return {
        userId,
        loginFrequency: loginCount || 0,
        lastActive: new Date(profile?.last_seen || Date.now()),
        featureUsage: {
          matching: matchCount || 0,
          messaging: messageCount || 0,
          support: supportCount || 0
        },
        supportTickets: supportCount || 0,
        subscriptionStatus: subscription?.status || 'free',
        paymentIssues: 0, // Would be calculated from payment failure logs
        engagementScore
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user behavior pattern')
      throw error
    }
  }

  // Calculate user engagement score (0-100)
  private static calculateEngagementScore(
    logins: number, 
    matches: number, 
    messages: number, 
    daysSinceJoin: number
  ): number {
    const expectedLogins = Math.min(daysSinceJoin, 30) // Expected logins in 30 days
    const loginScore = Math.min((logins / expectedLogins) * 40, 40) // Max 40 points
    const matchScore = Math.min(matches * 2, 30) // Max 30 points
    const messageScore = Math.min(messages * 0.5, 30) // Max 30 points
    
    return Math.round(loginScore + matchScore + messageScore)
  }

  // Check for payment-related issues
  private static async checkPaymentIssues(userId: string, pattern: UserBehaviorPattern): Promise<ProactiveAlert[]> {
    const alerts: ProactiveAlert[] = []
    
    // Check for recent payment failures (would integrate with payment system)
    if (pattern.paymentIssues > 0) {
      alerts.push({
        type: 'payment_failure',
        severity: 'high',
        userId,
        message: 'Payment method may need updating',
        suggestedAction: 'Proactively reach out about payment method update',
        preventiveMessage: 'Hi! I noticed there might be an issue with your payment method. I can help you update it to ensure uninterrupted service.',
        timeframe: 'immediate'
      })
    }

    return alerts
  }

  // Check for subscription-related issues
  private static async checkSubscriptionIssues(userId: string, pattern: UserBehaviorPattern): Promise<ProactiveAlert[]> {
    const alerts: ProactiveAlert[] = []
    
    try {
      // Check for subscription expiring soon
      const { data: subscription } = await supabase
        .from('subscriptions')
        .select('status, started_at, plan_type')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single()

      if (subscription) {
        const startDate = new Date(subscription.started_at)
        const daysSinceStart = Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24))
        
        // Monthly subscription approaching renewal
        if (daysSinceStart >= 25 && daysSinceStart <= 30) {
          alerts.push({
            type: 'subscription_expiry',
            severity: 'medium',
            userId,
            message: 'Subscription renewal approaching',
            suggestedAction: 'Send renewal reminder with benefits',
            preventiveMessage: 'Your premium subscription renews in a few days! You\'ve been enjoying unlimited matches and premium features. Is there anything you\'d like to know about your subscription?',
            timeframe: 'within_24h'
          })
        }
      }

      // Check for users who might be considering cancellation
      if (pattern.subscriptionStatus === 'active' && pattern.engagementScore < 30) {
        alerts.push({
          type: 'low_engagement',
          severity: 'medium',
          userId,
          message: 'Premium user with low engagement - cancellation risk',
          suggestedAction: 'Proactive engagement to prevent churn',
          preventiveMessage: 'I noticed you haven\'t been as active lately. Is everything working well for you? I\'d love to help you get the most out of your premium features!',
          timeframe: 'within_24h'
        })
      }
    } catch (error) {
      // Subscription not found or error - user might be on free plan
    }

    return alerts
  }

  // Check for engagement issues
  private static async checkEngagementIssues(userId: string, pattern: UserBehaviorPattern): Promise<ProactiveAlert[]> {
    const alerts: ProactiveAlert[] = []
    
    // Low engagement for new users
    const daysSinceLastActive = Math.floor((Date.now() - pattern.lastActive.getTime()) / (1000 * 60 * 60 * 24))
    
    if (daysSinceLastActive >= 7 && pattern.engagementScore < 20) {
      alerts.push({
        type: 'low_engagement',
        severity: 'medium',
        userId,
        message: 'User inactive for a week with low engagement',
        suggestedAction: 'Re-engagement campaign with tips and encouragement',
        preventiveMessage: 'Hey! I noticed you haven\'t been active lately. Is there anything I can help you with to improve your Circle experience? I have some great tips for getting more matches!',
        timeframe: 'within_24h'
      })
    }

    // No matches for active users
    if (pattern.featureUsage.matching === 0 && pattern.loginFrequency > 5) {
      alerts.push({
        type: 'feature_confusion',
        severity: 'medium',
        userId,
        message: 'Active user with no matches - possible confusion',
        suggestedAction: 'Offer matching guidance and profile optimization',
        preventiveMessage: 'I see you\'ve been active but haven\'t found matches yet. Would you like some personalized tips to optimize your profile and improve your matching success?',
        timeframe: 'within_24h'
      })
    }

    return alerts
  }

  // Check for technical issues
  private static async checkTechnicalIssues(userId: string, pattern: UserBehaviorPattern): Promise<ProactiveAlert[]> {
    const alerts: ProactiveAlert[] = []
    
    // High support ticket volume
    if (pattern.supportTickets >= 3) {
      alerts.push({
        type: 'technical_issue',
        severity: 'high',
        userId,
        message: 'Multiple support requests - possible technical issue',
        suggestedAction: 'Priority technical support and issue investigation',
        preventiveMessage: 'I noticed you\'ve contacted support several times recently. I want to make sure we resolve any ongoing issues for you. Can I help investigate what\'s been happening?',
        timeframe: 'immediate'
      })
    }

    return alerts
  }

  // Check for feature confusion
  private static async checkFeatureConfusion(userId: string, pattern: UserBehaviorPattern): Promise<ProactiveAlert[]> {
    const alerts: ProactiveAlert[] = []
    
    // Premium user not using premium features
    if (pattern.subscriptionStatus === 'active' && pattern.featureUsage.matching < 5) {
      alerts.push({
        type: 'feature_confusion',
        severity: 'low',
        userId,
        message: 'Premium user underutilizing features',
        suggestedAction: 'Feature education and onboarding',
        preventiveMessage: 'I noticed you have premium access but might not be using all the amazing features available to you. Would you like a quick tour of your premium benefits?',
        timeframe: 'within_week'
      })
    }

    return alerts
  }

  // Generate proactive outreach messages
  static generateProactiveMessage(alert: ProactiveAlert, userName?: string): string {
    const name = userName || 'there'
    
    if (alert.preventiveMessage) {
      return alert.preventiveMessage.replace(/Hi!|Hey!/, `Hi ${name}!`)
    }
    
    // Fallback messages based on alert type
    switch (alert.type) {
      case 'payment_failure':
        return `Hi ${name}! I wanted to reach out about your account. It looks like there might be an issue with your payment method. I'm here to help you update it quickly so you don't miss out on any premium features.`
      
      case 'subscription_expiry':
        return `Hello ${name}! Your premium subscription is coming up for renewal soon. You've been getting great value from unlimited matches and premium features. Is there anything you'd like to know about your subscription?`
      
      case 'low_engagement':
        return `Hi ${name}! I noticed you haven't been as active on Circle lately. Is everything working well for you? I'd love to help you get the most out of your experience and find great connections!`
      
      case 'technical_issue':
        return `Hello ${name}, I see you've been experiencing some issues recently. I want to make sure we get everything working perfectly for you. Can I help resolve any ongoing problems?`
      
      case 'feature_confusion':
        return `Hi ${name}! I'm here to help you get the most out of Circle. Would you like some personalized tips to enhance your experience and improve your success on the platform?`
      
      default:
        return `Hello ${name}! I'm reaching out to see how your Circle experience is going. Is there anything I can help you with today?`
    }
  }

  // Batch process proactive alerts for multiple users
  static async processProactiveAlerts(userIds: string[]): Promise<Map<string, ProactiveAlert[]>> {
    const results = new Map<string, ProactiveAlert[]>()
    
    for (const userId of userIds) {
      try {
        const alerts = await this.detectPotentialIssues(userId)
        if (alerts.length > 0) {
          results.set(userId, alerts)
        }
      } catch (error) {
        logger.error({ error, userId }, 'Error processing proactive alerts for user')
      }
    }
    
    return results
  }

  // Get users who need proactive outreach
  static async getUsersNeedingProactiveSupport(): Promise<string[]> {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      
      // Get users with potential issues
      const { data: inactiveUsers } = await supabase
        .from('profiles')
        .select('id')
        .lt('last_seen', sevenDaysAgo.toISOString())
        .gte('created_at', thirtyDaysAgo.toISOString())
        .limit(100)

      const { data: premiumUsers } = await supabase
        .from('subscriptions')
        .select('user_id')
        .eq('status', 'active')
        .limit(50)

      // Combine and deduplicate
      const userIds = new Set<string>()
      
      inactiveUsers?.forEach(user => userIds.add(user.id))
      premiumUsers?.forEach(sub => userIds.add(sub.user_id))
      
      return Array.from(userIds)
    } catch (error) {
      logger.error({ error }, 'Error getting users needing proactive support')
      return []
    }
  }
}

export default ProactiveSupportService
