import { supabase } from '../../config/supabase.js'
import { logger } from '../../config/logger.js'
import SentimentAnalysisService from './sentiment-analysis.service.js'
import SatisfactionTrackingService from './satisfaction-tracking.service.js'

export interface ConversationAnalytics {
  totalConversations: number
  averageLength: number
  resolutionRate: number
  escalationRate: number
  averageResponseTime: number
  topIssueTypes: { type: string; count: number; percentage: number }[]
  sentimentDistribution: Record<string, number>
  satisfactionScore: number
  costPerConversation: number
  aiEfficiencyScore: number
}

export interface AgentPerformance {
  agentId: string
  agentName: string
  agentType: 'ai' | 'human'
  conversationsHandled: number
  averageRating: number
  resolutionRate: number
  averageResponseTime: number
  escalationRate: number
  customerSatisfaction: number
  efficiency: number
  specialties: string[]
  languages: string[]
}

export interface CustomerInsights {
  userId: string
  totalInteractions: number
  averageSatisfaction: number
  commonIssues: string[]
  preferredLanguage: string
  riskLevel: 'low' | 'medium' | 'high'
  lifetimeValue: number
  churnRisk: number
  engagementScore: number
  lastInteraction: Date
}

export interface BusinessInsights {
  customerSatisfactionTrend: { date: string; score: number }[]
  issueResolutionTrends: { issue: string; trend: 'improving' | 'declining' | 'stable' }[]
  costOptimizationOpportunities: string[]
  aiPerformanceMetrics: {
    accuracy: number
    efficiency: number
    customerPreference: number
  }
  recommendedActions: {
    priority: 'high' | 'medium' | 'low'
    action: string
    impact: string
    effort: string
  }[]
}

export interface RealTimeMetrics {
  activeConversations: number
  queueLength: number
  averageWaitTime: number
  agentUtilization: number
  currentSatisfactionScore: number
  issuesResolvedToday: number
  escalationsToday: number
  responseTimeP95: number
}

export class AnalyticsInsightsService {
  // Get comprehensive conversation analytics
  static async getConversationAnalytics(
    startDate?: Date,
    endDate?: Date,
    filters?: {
      agentType?: 'ai' | 'human'
      issueType?: string
      userTier?: string
    }
  ): Promise<ConversationAnalytics> {
    try {
      let query = supabase
        .from('ai_conversations')
        .select(`
          id, status, intent, estimated_cost, satisfaction_rating, 
          created_at, updated_at, messages, user_context
        `)

      if (startDate) {
        query = query.gte('created_at', startDate.toISOString())
      }

      if (endDate) {
        query = query.lte('created_at', endDate.toISOString())
      }

      const { data: conversations, error } = await query

      if (error) throw error

      if (!conversations || conversations.length === 0) {
        return this.getEmptyAnalytics()
      }

      // Calculate metrics
      const totalConversations = conversations.length
      
      // Average conversation length (number of messages)
      const messageCounts = conversations.map(c => {
        try {
          return JSON.parse(c.messages || '[]').length
        } catch {
          return 0
        }
      })
      const averageLength = messageCounts.reduce((sum, count) => sum + count, 0) / totalConversations

      // Resolution rate (resolved vs escalated/abandoned)
      const resolvedCount = conversations.filter(c => c.status === 'resolved').length
      const resolutionRate = (resolvedCount / totalConversations) * 100

      // Escalation rate
      const escalatedCount = conversations.filter(c => c.status === 'escalated').length
      const escalationRate = (escalatedCount / totalConversations) * 100

      // Average response time (simplified calculation)
      const responseTimes = conversations.map(c => {
        const created = new Date(c.created_at)
        const updated = new Date(c.updated_at)
        return (updated.getTime() - created.getTime()) / (1000 * 60) // minutes
      })
      const averageResponseTime = responseTimes.reduce((sum, time) => sum + time, 0) / totalConversations

      // Top issue types
      const issueTypes: Record<string, number> = {}
      conversations.forEach(c => {
        const intent = c.intent || 'general'
        issueTypes[intent] = (issueTypes[intent] || 0) + 1
      })
      
      const topIssueTypes = Object.entries(issueTypes)
        .map(([type, count]) => ({
          type,
          count,
          percentage: (count / totalConversations) * 100
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10)

      // Sentiment distribution (would analyze messages)
      const sentimentDistribution = await this.analyzeSentimentDistribution(conversations)

      // Satisfaction score
      const ratingsWithValues = conversations
        .filter(c => c.satisfaction_rating)
        .map(c => c.satisfaction_rating)
      const satisfactionScore = ratingsWithValues.length > 0
        ? ratingsWithValues.reduce((sum, rating) => sum + rating, 0) / ratingsWithValues.length
        : 0

      // Cost per conversation
      const totalCost = conversations.reduce((sum, c) => sum + (c.estimated_cost || 0), 0)
      const costPerConversation = totalCost / totalConversations

      // AI efficiency score (combination of resolution rate, satisfaction, and cost)
      const aiEfficiencyScore = this.calculateEfficiencyScore(
        resolutionRate,
        satisfactionScore,
        costPerConversation,
        averageResponseTime
      )

      return {
        totalConversations,
        averageLength,
        resolutionRate,
        escalationRate,
        averageResponseTime,
        topIssueTypes,
        sentimentDistribution,
        satisfactionScore,
        costPerConversation,
        aiEfficiencyScore
      }
    } catch (error) {
      logger.error({ error }, 'Error getting conversation analytics')
      throw error
    }
  }

  // Get agent performance metrics
  static async getAgentPerformance(
    agentId?: string,
    agentType?: 'ai' | 'human'
  ): Promise<AgentPerformance[]> {
    try {
      // For AI agents, analyze AI conversations
      if (agentType === 'ai' || !agentType) {
        const aiPerformance = await this.getAIAgentPerformance()
        if (agentId && agentId !== 'ai_assistant') {
          return []
        }
        return agentId ? [aiPerformance] : [aiPerformance]
      }

      // For human agents, would query human agent data
      // This is a placeholder for human agent analytics
      return []
    } catch (error) {
      logger.error({ error, agentId, agentType }, 'Error getting agent performance')
      throw error
    }
  }

  // Get customer insights
  static async getCustomerInsights(userId?: string): Promise<CustomerInsights[]> {
    try {
      let query = supabase
        .from('ai_conversations')
        .select(`
          user_id, satisfaction_rating, intent, created_at, 
          user_context, status, messages
        `)

      if (userId) {
        query = query.eq('user_id', userId)
      }

      const { data: conversations, error } = await query

      if (error) throw error

      if (!conversations || conversations.length === 0) {
        return []
      }

      // Group by user
      const userGroups: Record<string, any[]> = {}
      conversations.forEach(conv => {
        if (conv.user_id) {
          if (!userGroups[conv.user_id]) {
            userGroups[conv.user_id] = []
          }
          userGroups[conv.user_id].push(conv)
        }
      })

      // Generate insights for each user
      const insights: CustomerInsights[] = []
      
      for (const [userId, userConversations] of Object.entries(userGroups)) {
        const insight = await this.generateCustomerInsight(userId, userConversations)
        insights.push(insight)
      }

      return insights.sort((a, b) => b.totalInteractions - a.totalInteractions)
    } catch (error) {
      logger.error({ error, userId }, 'Error getting customer insights')
      throw error
    }
  }

  // Get business insights and recommendations
  static async getBusinessInsights(): Promise<BusinessInsights> {
    try {
      // Get satisfaction trends
      const satisfactionMetrics = await SatisfactionTrackingService.getSatisfactionMetrics()
      
      // Analyze issue resolution trends
      const issueResolutionTrends = await this.analyzeIssueResolutionTrends()
      
      // Identify cost optimization opportunities
      const costOptimizationOpportunities = await this.identifyCostOptimizations()
      
      // Calculate AI performance metrics
      const aiPerformanceMetrics = await this.calculateAIPerformanceMetrics()
      
      // Generate recommended actions
      const recommendedActions = await this.generateRecommendedActions(
        satisfactionMetrics,
        issueResolutionTrends,
        aiPerformanceMetrics
      )

      return {
        customerSatisfactionTrend: satisfactionMetrics.trendData,
        issueResolutionTrends,
        costOptimizationOpportunities,
        aiPerformanceMetrics,
        recommendedActions
      }
    } catch (error) {
      logger.error({ error }, 'Error getting business insights')
      throw error
    }
  }

  // Get real-time metrics
  static async getRealTimeMetrics(): Promise<RealTimeMetrics> {
    try {
      const today = new Date()
      today.setHours(0, 0, 0, 0)

      // Active conversations (last 30 minutes)
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000)
      const { count: activeConversations } = await supabase
        .from('ai_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')
        .gte('updated_at', thirtyMinutesAgo.toISOString())

      // Queue length (pending conversations)
      const { count: queueLength } = await supabase
        .from('ai_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active')

      // Issues resolved today
      const { count: issuesResolvedToday } = await supabase
        .from('ai_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'resolved')
        .gte('updated_at', today.toISOString())

      // Escalations today
      const { count: escalationsToday } = await supabase
        .from('ai_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'escalated')
        .gte('created_at', today.toISOString())

      // Current satisfaction score (last 24 hours)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      const { data: recentRatings } = await supabase
        .from('satisfaction_ratings')
        .select('rating')
        .gte('created_at', yesterday.toISOString())

      const currentSatisfactionScore = recentRatings && recentRatings.length > 0
        ? recentRatings.reduce((sum, r) => sum + r.rating, 0) / recentRatings.length
        : 0

      return {
        activeConversations: activeConversations || 0,
        queueLength: queueLength || 0,
        averageWaitTime: 2, // Would calculate from actual data
        agentUtilization: 75, // Would calculate from agent data
        currentSatisfactionScore,
        issuesResolvedToday: issuesResolvedToday || 0,
        escalationsToday: escalationsToday || 0,
        responseTimeP95: 5 // Would calculate from response time data
      }
    } catch (error) {
      logger.error({ error }, 'Error getting real-time metrics')
      throw error
    }
  }

  // Helper methods
  private static getEmptyAnalytics(): ConversationAnalytics {
    return {
      totalConversations: 0,
      averageLength: 0,
      resolutionRate: 0,
      escalationRate: 0,
      averageResponseTime: 0,
      topIssueTypes: [],
      sentimentDistribution: {},
      satisfactionScore: 0,
      costPerConversation: 0,
      aiEfficiencyScore: 0
    }
  }

  private static async analyzeSentimentDistribution(conversations: any[]): Promise<Record<string, number>> {
    const sentiments: Record<string, number> = {
      positive: 0,
      negative: 0,
      neutral: 0,
      frustrated: 0,
      angry: 0
    }

    // Sample analysis - would analyze actual messages
    conversations.forEach(conv => {
      try {
        const messages = JSON.parse(conv.messages || '[]')
        const userMessages = messages.filter((m: any) => m.role === 'user')
        
        if (userMessages.length > 0) {
          // Simplified sentiment analysis
          const lastMessage = userMessages[userMessages.length - 1]
          const analysis = SentimentAnalysisService.analyzeSentiment(lastMessage.content || '')
          sentiments[analysis.sentiment] = (sentiments[analysis.sentiment] || 0) + 1
        }
      } catch {
        sentiments.neutral++
      }
    })

    return sentiments
  }

  private static calculateEfficiencyScore(
    resolutionRate: number,
    satisfactionScore: number,
    costPerConversation: number,
    averageResponseTime: number
  ): number {
    // Normalize metrics to 0-100 scale
    const normalizedResolution = Math.min(resolutionRate, 100)
    const normalizedSatisfaction = (satisfactionScore / 5) * 100
    const normalizedCost = Math.max(0, 100 - (costPerConversation * 10)) // Lower cost = higher score
    const normalizedSpeed = Math.max(0, 100 - averageResponseTime) // Faster = higher score

    // Weighted average
    const weights = { resolution: 0.3, satisfaction: 0.4, cost: 0.2, speed: 0.1 }
    
    return Math.round(
      normalizedResolution * weights.resolution +
      normalizedSatisfaction * weights.satisfaction +
      normalizedCost * weights.cost +
      normalizedSpeed * weights.speed
    )
  }

  private static async getAIAgentPerformance(): Promise<AgentPerformance> {
    const analytics = await this.getConversationAnalytics()
    
    return {
      agentId: 'ai_assistant',
      agentName: 'AI Assistant',
      agentType: 'ai',
      conversationsHandled: analytics.totalConversations,
      averageRating: analytics.satisfactionScore,
      resolutionRate: analytics.resolutionRate,
      averageResponseTime: analytics.averageResponseTime,
      escalationRate: analytics.escalationRate,
      customerSatisfaction: analytics.satisfactionScore,
      efficiency: analytics.aiEfficiencyScore,
      specialties: ['general_support', 'billing', 'technical', 'refunds'],
      languages: ['en', 'hi', 'es', 'fr', 'ar']
    }
  }

  private static async generateCustomerInsight(userId: string, conversations: any[]): Promise<CustomerInsights> {
    const totalInteractions = conversations.length
    
    // Calculate average satisfaction
    const ratingsWithValues = conversations
      .filter(c => c.satisfaction_rating)
      .map(c => c.satisfaction_rating)
    const averageSatisfaction = ratingsWithValues.length > 0
      ? ratingsWithValues.reduce((sum, rating) => sum + rating, 0) / ratingsWithValues.length
      : 0

    // Extract common issues
    const issues: Record<string, number> = {}
    conversations.forEach(c => {
      const intent = c.intent || 'general'
      issues[intent] = (issues[intent] || 0) + 1
    })
    const commonIssues = Object.entries(issues)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([issue]) => issue)

    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'low'
    if (averageSatisfaction < 2.5) riskLevel = 'high'
    else if (averageSatisfaction < 3.5) riskLevel = 'medium'

    // Calculate engagement score
    const recentInteractions = conversations.filter(c => 
      new Date(c.created_at) > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    ).length
    const engagementScore = Math.min(recentInteractions * 20, 100)

    // Calculate churn risk
    const daysSinceLastInteraction = Math.floor(
      (Date.now() - new Date(conversations[0].created_at).getTime()) / (1000 * 60 * 60 * 24)
    )
    const churnRisk = Math.min(daysSinceLastInteraction * 2, 100)

    return {
      userId,
      totalInteractions,
      averageSatisfaction,
      commonIssues,
      preferredLanguage: 'en', // Would detect from conversations
      riskLevel,
      lifetimeValue: 0, // Would calculate from subscription data
      churnRisk,
      engagementScore,
      lastInteraction: new Date(conversations[0].created_at)
    }
  }

  private static async analyzeIssueResolutionTrends(): Promise<{ issue: string; trend: 'improving' | 'declining' | 'stable' }[]> {
    // Placeholder implementation
    return [
      { issue: 'billing', trend: 'improving' },
      { issue: 'technical', trend: 'stable' },
      { issue: 'refunds', trend: 'declining' }
    ]
  }

  private static async identifyCostOptimizations(): Promise<string[]> {
    return [
      'Implement automated responses for common billing questions',
      'Improve AI training for technical issues to reduce escalations',
      'Add proactive notifications to prevent subscription issues'
    ]
  }

  private static async calculateAIPerformanceMetrics(): Promise<{
    accuracy: number
    efficiency: number
    customerPreference: number
  }> {
    const analytics = await this.getConversationAnalytics()
    
    return {
      accuracy: analytics.resolutionRate,
      efficiency: analytics.aiEfficiencyScore,
      customerPreference: (analytics.satisfactionScore / 5) * 100
    }
  }

  private static async generateRecommendedActions(
    satisfactionMetrics: any,
    issueResolutionTrends: any[],
    aiPerformanceMetrics: any
  ): Promise<BusinessInsights['recommendedActions']> {
    const actions: BusinessInsights['recommendedActions'] = []

    if (satisfactionMetrics.averageRating < 3.5) {
      actions.push({
        priority: 'high',
        action: 'Improve customer satisfaction scores',
        impact: 'Reduce churn and improve customer loyalty',
        effort: 'Medium - requires training and process improvements'
      })
    }

    if (aiPerformanceMetrics.accuracy < 80) {
      actions.push({
        priority: 'high',
        action: 'Enhance AI training and knowledge base',
        impact: 'Increase resolution rate and reduce escalations',
        effort: 'High - requires significant AI model improvements'
      })
    }

    actions.push({
      priority: 'medium',
      action: 'Implement proactive customer outreach',
      impact: 'Prevent issues before they become support tickets',
      effort: 'Low - can be automated with existing data'
    })

    return actions
  }

  // Generate comprehensive analytics report
  static async generateAnalyticsReport(period: 'week' | 'month' | 'quarter'): Promise<{
    conversationAnalytics: ConversationAnalytics
    agentPerformance: AgentPerformance[]
    businessInsights: BusinessInsights
    realTimeMetrics: RealTimeMetrics
    executiveSummary: string[]
  }> {
    const endDate = new Date()
    const startDate = new Date()
    
    switch (period) {
      case 'week':
        startDate.setDate(endDate.getDate() - 7)
        break
      case 'month':
        startDate.setMonth(endDate.getMonth() - 1)
        break
      case 'quarter':
        startDate.setMonth(endDate.getMonth() - 3)
        break
    }

    const [conversationAnalytics, agentPerformance, businessInsights, realTimeMetrics] = await Promise.all([
      this.getConversationAnalytics(startDate, endDate),
      this.getAgentPerformance(),
      this.getBusinessInsights(),
      this.getRealTimeMetrics()
    ])

    const executiveSummary = [
      `Handled ${conversationAnalytics.totalConversations} conversations with ${conversationAnalytics.resolutionRate.toFixed(1)}% resolution rate`,
      `Customer satisfaction: ${conversationAnalytics.satisfactionScore.toFixed(1)}/5.0`,
      `AI efficiency score: ${conversationAnalytics.aiEfficiencyScore}/100`,
      `${realTimeMetrics.escalationsToday} escalations today, ${realTimeMetrics.issuesResolvedToday} issues resolved`
    ]

    return {
      conversationAnalytics,
      agentPerformance,
      businessInsights,
      realTimeMetrics,
      executiveSummary
    }
  }
}

export default AnalyticsInsightsService
