import { supabase } from '../../config/supabase.js'
import { logger } from '../../config/logger.js'
import SentimentAnalysisService, { type SentimentAnalysis } from './sentiment-analysis.service.js'

export interface EscalationRule {
  id: string
  name: string
  priority: 'low' | 'medium' | 'high' | 'critical'
  conditions: EscalationCondition[]
  actions: EscalationAction[]
  enabled: boolean
}

export interface EscalationCondition {
  type: 'sentiment' | 'keyword' | 'user_tier' | 'issue_type' | 'resolution_attempts' | 'time_threshold'
  operator: 'equals' | 'contains' | 'greater_than' | 'less_than' | 'in_list'
  value: any
  weight: number
}

export interface EscalationAction {
  type: 'route_to_human' | 'priority_queue' | 'manager_notification' | 'compensation_offer' | 'callback_request'
  parameters: Record<string, any>
  delay?: number // seconds
}

export interface EscalationDecision {
  shouldEscalate: boolean
  priority: 'low' | 'medium' | 'high' | 'critical'
  reason: string
  suggestedActions: EscalationAction[]
  estimatedWaitTime: number
  assignedAgent?: string
  escalationPath: string[]
}

export interface AgentCapability {
  agentId: string
  name: string
  languages: string[]
  specialties: string[]
  currentLoad: number
  maxLoad: number
  availability: 'available' | 'busy' | 'offline'
  rating: number
  responseTime: number // average in minutes
}

export class EscalationSystemService {
  // Predefined escalation rules
  private static escalationRules: EscalationRule[] = [
    {
      id: 'critical_anger',
      name: 'Critical Anger Detection',
      priority: 'critical',
      conditions: [
        { type: 'sentiment', operator: 'equals', value: 'angry', weight: 0.8 },
        { type: 'keyword', operator: 'contains', value: ['lawsuit', 'lawyer', 'fraud'], weight: 0.9 }
      ],
      actions: [
        { type: 'manager_notification', parameters: { immediate: true } },
        { type: 'route_to_human', parameters: { specialty: 'crisis_management', priority: 'critical' } }
      ],
      enabled: true
    },
    {
      id: 'premium_user_frustration',
      name: 'Premium User Frustration',
      priority: 'high',
      conditions: [
        { type: 'user_tier', operator: 'in_list', value: ['premium', 'premium_plus'], weight: 0.6 },
        { type: 'sentiment', operator: 'equals', value: 'frustrated', weight: 0.7 },
        { type: 'resolution_attempts', operator: 'greater_than', value: 2, weight: 0.8 }
      ],
      actions: [
        { type: 'route_to_human', parameters: { specialty: 'premium_support', priority: 'high' } },
        { type: 'compensation_offer', parameters: { type: 'service_credit', amount: 50 } }
      ],
      enabled: true
    },
    {
      id: 'payment_issues',
      name: 'Payment Related Issues',
      priority: 'high',
      conditions: [
        { type: 'keyword', operator: 'contains', value: ['payment', 'billing', 'charge', 'refund'], weight: 0.7 },
        { type: 'sentiment', operator: 'in_list', value: ['frustrated', 'angry'], weight: 0.6 }
      ],
      actions: [
        { type: 'route_to_human', parameters: { specialty: 'billing_support', priority: 'high' } }
      ],
      enabled: true
    },
    {
      id: 'technical_complexity',
      name: 'Complex Technical Issues',
      priority: 'medium',
      conditions: [
        { type: 'keyword', operator: 'contains', value: ['bug', 'error', 'crash', 'not working'], weight: 0.6 },
        { type: 'resolution_attempts', operator: 'greater_than', value: 3, weight: 0.7 }
      ],
      actions: [
        { type: 'route_to_human', parameters: { specialty: 'technical_support', priority: 'medium' } }
      ],
      enabled: true
    },
    {
      id: 'language_barrier',
      name: 'Language Support Needed',
      priority: 'medium',
      conditions: [
        { type: 'keyword', operator: 'contains', value: ['hindi', 'spanish', 'french', 'arabic'], weight: 0.8 }
      ],
      actions: [
        { type: 'route_to_human', parameters: { language_required: true, priority: 'medium' } }
      ],
      enabled: true
    }
  ]

  // Mock agent data (would come from database in production)
  private static availableAgents: AgentCapability[] = [
    {
      agentId: 'agent_001',
      name: 'Sarah Johnson',
      languages: ['en'],
      specialties: ['general_support', 'billing_support'],
      currentLoad: 2,
      maxLoad: 5,
      availability: 'available',
      rating: 4.8,
      responseTime: 3
    },
    {
      agentId: 'agent_002',
      name: 'Raj Patel',
      languages: ['en', 'hi'],
      specialties: ['technical_support', 'premium_support'],
      currentLoad: 1,
      maxLoad: 4,
      availability: 'available',
      rating: 4.9,
      responseTime: 2
    },
    {
      agentId: 'agent_003',
      name: 'Maria Garcia',
      languages: ['en', 'es'],
      specialties: ['general_support', 'crisis_management'],
      currentLoad: 3,
      maxLoad: 5,
      availability: 'busy',
      rating: 4.7,
      responseTime: 5
    },
    {
      agentId: 'agent_004',
      name: 'Ahmed Hassan',
      languages: ['en', 'ar'],
      specialties: ['billing_support', 'premium_support'],
      currentLoad: 0,
      maxLoad: 4,
      availability: 'available',
      rating: 4.6,
      responseTime: 4
    }
  ]

  // Evaluate if conversation should be escalated
  static async evaluateEscalation(
    conversationId: string,
    userId: string,
    message: string,
    conversationHistory: string[],
    userTier: string = 'free'
  ): Promise<EscalationDecision> {
    try {
      // Analyze current message sentiment
      const sentimentAnalysis = SentimentAnalysisService.analyzeSentiment(message, {
        messageHistory: conversationHistory,
        issueType: this.detectIssueType(message),
        resolutionAttempts: conversationHistory.length,
        customerTier: userTier as any,
        previousInteractions: await this.getPreviousInteractionCount(userId)
      })

      // Evaluate against escalation rules
      const matchedRules = this.evaluateRules(message, sentimentAnalysis, userTier, conversationHistory.length)
      
      // Determine if escalation is needed
      const shouldEscalate = matchedRules.length > 0 || this.shouldAutoEscalate(sentimentAnalysis, conversationHistory.length)
      
      if (!shouldEscalate) {
        return {
          shouldEscalate: false,
          priority: 'low',
          reason: 'No escalation criteria met',
          suggestedActions: [],
          estimatedWaitTime: 0,
          escalationPath: []
        }
      }

      // Determine priority and actions
      const priority = this.determinePriority(matchedRules, sentimentAnalysis)
      const suggestedActions = this.collectActions(matchedRules)
      const assignedAgent = await this.findBestAgent(suggestedActions, message)
      const estimatedWaitTime = this.calculateWaitTime(priority, assignedAgent)
      const escalationPath = this.buildEscalationPath(matchedRules, priority)

      // Log escalation decision
      await this.logEscalation(conversationId, userId, {
        reason: matchedRules.map(r => r.name).join(', ') || 'Auto-escalation criteria met',
        priority,
        sentimentScore: sentimentAnalysis.confidence,
        assignedAgent: assignedAgent?.agentId
      })

      return {
        shouldEscalate: true,
        priority,
        reason: this.buildEscalationReason(matchedRules, sentimentAnalysis),
        suggestedActions,
        estimatedWaitTime,
        assignedAgent: assignedAgent?.agentId,
        escalationPath
      }
    } catch (error) {
      logger.error({ error, conversationId, userId }, 'Error evaluating escalation')
      
      // Safe fallback - escalate if there's an error
      return {
        shouldEscalate: true,
        priority: 'medium',
        reason: 'System error - escalating for safety',
        suggestedActions: [{ type: 'route_to_human', parameters: { specialty: 'general_support' } }],
        estimatedWaitTime: 10,
        escalationPath: ['system_error']
      }
    }
  }

  // Evaluate message against escalation rules
  private static evaluateRules(
    message: string,
    sentimentAnalysis: SentimentAnalysis,
    userTier: string,
    resolutionAttempts: number
  ): EscalationRule[] {
    const matchedRules: EscalationRule[] = []
    const lowerMessage = message.toLowerCase()

    for (const rule of this.escalationRules) {
      if (!rule.enabled) continue

      let ruleScore = 0
      let totalWeight = 0

      for (const condition of rule.conditions) {
        totalWeight += condition.weight
        
        if (this.evaluateCondition(condition, {
          message: lowerMessage,
          sentiment: sentimentAnalysis,
          userTier,
          resolutionAttempts
        })) {
          ruleScore += condition.weight
        }
      }

      // Rule matches if score is above threshold (70%)
      if (ruleScore / totalWeight >= 0.7) {
        matchedRules.push(rule)
      }
    }

    return matchedRules.sort((a, b) => this.getPriorityValue(b.priority) - this.getPriorityValue(a.priority))
  }

  // Evaluate individual condition
  private static evaluateCondition(
    condition: EscalationCondition,
    context: {
      message: string
      sentiment: SentimentAnalysis
      userTier: string
      resolutionAttempts: number
    }
  ): boolean {
    switch (condition.type) {
      case 'sentiment':
        return condition.operator === 'equals' 
          ? context.sentiment.sentiment === condition.value
          : condition.operator === 'in_list' 
          ? condition.value.includes(context.sentiment.sentiment)
          : false

      case 'keyword':
        if (condition.operator === 'contains') {
          const keywords = Array.isArray(condition.value) ? condition.value : [condition.value]
          return keywords.some(keyword => context.message.includes(keyword.toLowerCase()))
        }
        return false

      case 'user_tier':
        return condition.operator === 'equals'
          ? context.userTier === condition.value
          : condition.operator === 'in_list'
          ? condition.value.includes(context.userTier)
          : false

      case 'resolution_attempts':
        return condition.operator === 'greater_than'
          ? context.resolutionAttempts > condition.value
          : condition.operator === 'less_than'
          ? context.resolutionAttempts < condition.value
          : context.resolutionAttempts === condition.value

      default:
        return false
    }
  }

  // Check if auto-escalation criteria are met
  private static shouldAutoEscalate(sentimentAnalysis: SentimentAnalysis, resolutionAttempts: number): boolean {
    // Auto-escalate for critical sentiment
    if (sentimentAnalysis.escalationRisk === 'critical') {
      return true
    }

    // Auto-escalate for high anger with multiple attempts
    if (sentimentAnalysis.sentiment === 'angry' && resolutionAttempts >= 2) {
      return true
    }

    // Auto-escalate for many resolution attempts
    if (resolutionAttempts >= 5) {
      return true
    }

    return false
  }

  // Determine overall priority from matched rules
  private static determinePriority(rules: EscalationRule[], sentimentAnalysis: SentimentAnalysis): EscalationDecision['priority'] {
    if (rules.length === 0) {
      return sentimentAnalysis.escalationRisk as EscalationDecision['priority']
    }

    // Return highest priority from matched rules
    const priorities = rules.map(r => r.priority)
    
    if (priorities.includes('critical')) return 'critical'
    if (priorities.includes('high')) return 'high'
    if (priorities.includes('medium')) return 'medium'
    return 'low'
  }

  // Collect all actions from matched rules
  private static collectActions(rules: EscalationRule[]): EscalationAction[] {
    const actions: EscalationAction[] = []
    
    rules.forEach(rule => {
      actions.push(...rule.actions)
    })

    // Remove duplicates and prioritize
    const uniqueActions = actions.filter((action, index, self) => 
      index === self.findIndex(a => a.type === action.type)
    )

    return uniqueActions
  }

  // Find best available agent for the escalation
  private static async findBestAgent(
    actions: EscalationAction[],
    message: string
  ): Promise<AgentCapability | undefined> {
    // Extract requirements from actions
    const routeAction = actions.find(a => a.type === 'route_to_human')
    if (!routeAction) return undefined

    const requiredSpecialty = routeAction.parameters.specialty
    const requiredLanguage = routeAction.parameters.language_required
    const priority = routeAction.parameters.priority

    // Filter agents by requirements
    let availableAgents = this.availableAgents.filter(agent => 
      agent.availability === 'available' && agent.currentLoad < agent.maxLoad
    )

    // Filter by specialty if required
    if (requiredSpecialty) {
      availableAgents = availableAgents.filter(agent => 
        agent.specialties.includes(requiredSpecialty)
      )
    }

    // Filter by language if required
    if (requiredLanguage) {
      const detectedLang = this.detectRequiredLanguage(message)
      if (detectedLang) {
        availableAgents = availableAgents.filter(agent => 
          agent.languages.includes(detectedLang)
        )
      }
    }

    if (availableAgents.length === 0) {
      // Fallback to busy agents if no available agents
      availableAgents = this.availableAgents.filter(agent => 
        agent.availability === 'busy' && agent.currentLoad < agent.maxLoad
      )
    }

    // Sort by rating and current load
    availableAgents.sort((a, b) => {
      const scoreA = a.rating - (a.currentLoad / a.maxLoad) * 2
      const scoreB = b.rating - (b.currentLoad / b.maxLoad) * 2
      return scoreB - scoreA
    })

    return availableAgents[0]
  }

  // Calculate estimated wait time
  private static calculateWaitTime(priority: string, agent?: AgentCapability): number {
    const baseTimes = { critical: 1, high: 3, medium: 8, low: 15 }
    let baseTime = baseTimes[priority as keyof typeof baseTimes] || 15

    if (agent) {
      // Adjust based on agent's current load and response time
      const loadFactor = agent.currentLoad / agent.maxLoad
      baseTime = Math.round(baseTime * (1 + loadFactor) + agent.responseTime)
    } else {
      // No agent available - longer wait time
      baseTime *= 2
    }

    return Math.max(baseTime, 1)
  }

  // Build escalation path
  private static buildEscalationPath(rules: EscalationRule[], priority: string): string[] {
    const path = ['ai_analysis']
    
    if (rules.length > 0) {
      path.push(...rules.map(r => r.id))
    }
    
    path.push(`${priority}_priority_queue`)
    path.push('human_agent')
    
    return path
  }

  // Build human-readable escalation reason
  private static buildEscalationReason(rules: EscalationRule[], sentimentAnalysis: SentimentAnalysis): string {
    if (rules.length === 0) {
      return `Auto-escalation due to ${sentimentAnalysis.sentiment} sentiment with ${sentimentAnalysis.escalationRisk} risk level`
    }

    const reasons = rules.map(r => r.name)
    return `Escalation triggered by: ${reasons.join(', ')}`
  }

  // Helper methods
  private static getPriorityValue(priority: string): number {
    const values = { critical: 4, high: 3, medium: 2, low: 1 }
    return values[priority as keyof typeof values] || 1
  }

  private static detectIssueType(message: string): string {
    const lowerMessage = message.toLowerCase()
    
    if (lowerMessage.includes('payment') || lowerMessage.includes('billing')) return 'billing'
    if (lowerMessage.includes('refund') || lowerMessage.includes('cancel')) return 'refund'
    if (lowerMessage.includes('bug') || lowerMessage.includes('error')) return 'technical'
    if (lowerMessage.includes('match') || lowerMessage.includes('profile')) return 'matching'
    
    return 'general'
  }

  private static detectRequiredLanguage(message: string): string | null {
    // Simple language detection for escalation purposes
    if (/[\u0900-\u097F]/.test(message)) return 'hi'
    if (/[\u0600-\u06FF]/.test(message)) return 'ar'
    if (message.toLowerCase().includes('español') || message.toLowerCase().includes('spanish')) return 'es'
    
    return null
  }

  private static async getPreviousInteractionCount(userId: string): Promise<number> {
    try {
      const { count } = await supabase
        .from('ai_conversations')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
      
      return count || 0
    } catch (error) {
      return 0
    }
  }

  private static async logEscalation(
    conversationId: string,
    userId: string,
    escalationData: {
      reason: string
      priority: string
      sentimentScore: number
      assignedAgent?: string
    }
  ): Promise<void> {
    try {
      await supabase
        .from('escalation_logs')
        .insert({
          conversation_id: conversationId,
          user_id: userId,
          escalation_reason: escalationData.reason,
          priority: escalationData.priority,
          sentiment_score: escalationData.sentimentScore,
          assigned_agent: escalationData.assignedAgent,
          created_at: new Date().toISOString()
        })
    } catch (error) {
      logger.error({ error, conversationId }, 'Failed to log escalation')
    }
  }

  // Public methods for managing escalation rules
  static getEscalationRules(): EscalationRule[] {
    return this.escalationRules
  }

  static addEscalationRule(rule: EscalationRule): void {
    this.escalationRules.push(rule)
  }

  static updateEscalationRule(ruleId: string, updates: Partial<EscalationRule>): boolean {
    const index = this.escalationRules.findIndex(r => r.id === ruleId)
    if (index !== -1) {
      this.escalationRules[index] = { ...this.escalationRules[index], ...updates }
      return true
    }
    return false
  }

  static getAvailableAgents(): AgentCapability[] {
    return this.availableAgents.filter(agent => agent.availability === 'available')
  }
}

export default EscalationSystemService
