import { supabase } from '../../config/supabase.js'
import { logger } from '../../config/logger.js'
import { TogetherAIService, type AIMessage, type AIResponse } from './together-ai.service.js'
import { RefundPolicyService } from './refund-policy.service.js'
import { AdminActionsService } from './admin-actions.service.js'

export interface Conversation {
  id: string
  userId?: string
  sessionId: string
  messages: AIMessage[]
  status: 'active' | 'escalated' | 'resolved' | 'abandoned'
  intent: string
  refundExplanationCount: number
  estimatedCost: number
  tokenCount: number
  createdAt: Date
  updatedAt: Date
  userContext?: any
}

export interface ConversationSummary {
  conversationId: string
  userQuery: string
  resolution: string
  escalationReason?: string
  userSatisfaction?: number
}

export class ConversationService {
  private static readonly MAX_CONVERSATION_LENGTH = 50
  private static readonly CONVERSATION_TIMEOUT = 30 * 60 * 1000 // 30 minutes

  // Start a new conversation
  static async startConversation(
    sessionId: string,
    userId?: string,
    initialMessage?: string
  ): Promise<Conversation> {
    try {
      // Debug logging for sessionId
      logger.info({ 
        sessionId, 
        sessionIdType: typeof sessionId, 
        sessionIdLength: sessionId?.length,
        userId, 
        initialMessage 
      }, 'Starting new conversation')

      if (!sessionId) {
        throw new Error('Session ID is required to start a conversation')
      }

      const conversation: Conversation = {
        id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        userId,
        sessionId,
        messages: [],
        status: 'active',
        intent: 'general',
        refundExplanationCount: 0,
        estimatedCost: 0,
        tokenCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        userContext: userId ? await this.getUserContext(userId) : null
      }

      // Add welcome message
      const welcomeMessage: AIMessage = {
        role: 'assistant',
        content: `Hi! I'm Circle's AI assistant. I'm here to help with:
• Subscription questions and billing
• Refunds and cancellations  
• Technical support and troubleshooting
• Account assistance

How can I help you today?`,
        timestamp: new Date()
      }

      conversation.messages.push(welcomeMessage)

      // If there's an initial message, process it
      if (initialMessage) {
        const userMessage: AIMessage = {
          role: 'user',
          content: initialMessage,
          timestamp: new Date()
        }
        conversation.messages.push(userMessage)

        const aiResponse = await this.generateAIResponse(conversation)
        conversation.messages.push({
          role: 'assistant',
          content: aiResponse.message,
          timestamp: new Date()
        })

        conversation.intent = aiResponse.intent
        conversation.updatedAt = new Date()
      }

      // Store conversation in database
      await this.saveConversation(conversation)

      return conversation
    } catch (error) {
      logger.error({ error, sessionId, userId }, 'Error starting conversation')
      throw error
    }
  }

  // Add message to conversation and get AI response
  static async addMessage(
    conversationId: string,
    message: string,
    role: 'user' | 'assistant' = 'user'
  ): Promise<{ conversation: Conversation; aiResponse?: AIResponse }> {
    try {
      const conversation = await this.getConversation(conversationId)
      if (!conversation) {
        throw new Error('Conversation not found')
      }

      // Check if conversation is still active
      if (conversation.status !== 'active') {
        throw new Error('Conversation is no longer active')
      }

      // Check conversation timeout
      const timeSinceUpdate = Date.now() - conversation.updatedAt.getTime()
      if (timeSinceUpdate > this.CONVERSATION_TIMEOUT) {
        conversation.status = 'abandoned'
        await this.saveConversation(conversation)
        throw new Error('Conversation has timed out')
      }

      // Add user message
      const userMessage: AIMessage = {
        role,
        content: message,
        timestamp: new Date()
      }
      conversation.messages.push(userMessage)

      let aiResponse: AIResponse | undefined

      if (role === 'user') {
        // Generate AI response
        aiResponse = await this.generateAIResponse(conversation)
        
        // Add AI response to conversation
        conversation.messages.push({
          role: 'assistant',
          content: aiResponse.message,
          timestamp: new Date()
        })

        // Update conversation metadata
        conversation.intent = aiResponse.intent
        conversation.updatedAt = new Date()

        // Track cost and tokens (estimate)
        const messageTokens = this.estimateTokens(userMessage.content + aiResponse.message)
        conversation.tokenCount += messageTokens
        conversation.estimatedCost = TogetherAIService.estimateConversationCost(
          conversation.messages.length,
          conversation.tokenCount / conversation.messages.length
        )

        // Handle escalation or conversation end
        if (aiResponse.requiresEscalation) {
          conversation.status = 'escalated'
        } else if (aiResponse.conversationEnded) {
          conversation.status = 'resolved'
        }

        // Track refund explanations
        if (aiResponse.intent === 'refund' && aiResponse.message.toLowerCase().includes('7 days')) {
          conversation.refundExplanationCount++
        }
      }

      // Limit conversation length
      if (conversation.messages.length > this.MAX_CONVERSATION_LENGTH) {
        conversation.messages = conversation.messages.slice(-this.MAX_CONVERSATION_LENGTH)
      }

      // Save updated conversation
      await this.saveConversation(conversation)

      return { conversation, aiResponse }
    } catch (error) {
      logger.error({ error, conversationId, message }, 'Error adding message to conversation')
      throw error
    }
  }

  // Generate AI response with business logic and admin actions
  private static async generateAIResponse(conversation: Conversation): Promise<AIResponse> {
    try {
      const lastUserMessage = conversation.messages
        .filter(m => m.role === 'user')
        .slice(-1)[0]

      if (!lastUserMessage) {
        throw new Error('No user message found')
      }

      const messageContent = lastUserMessage.content.toLowerCase()

      // Handle admin actions if user is authenticated
      if (conversation.userId) {
        // Check subscription status
        if (this.isSubscriptionInquiry(messageContent)) {
          const result = await AdminActionsService.checkSubscriptionStatus(conversation.userId)
          return {
            message: result.message + (result.data?.hasActiveSubscription ? 
              `\n\nYour ${result.data.activeSubscription.plan_type} plan costs ${result.data.activeSubscription.price_paid} ${result.data.activeSubscription.currency} and started on ${new Date(result.data.activeSubscription.started_at).toLocaleDateString()}.` : 
              '\n\nWould you like to upgrade to a premium plan?'),
            confidence: 0.95,
            intent: 'subscription_inquiry',
            requiresEscalation: false,
            conversationEnded: false
          }
        }

        // Handle refund requests with automatic processing
        if (this.isRefundRequest(messageContent)) {
          // Check if user wants automatic refund processing
          if (this.isRefundProcessingRequest(messageContent)) {
            const result = await AdminActionsService.processRefund(conversation.userId, 'AI Assistant - User requested refund')
            return {
              message: result.message + (result.success ? 
                '\n\nYour subscription has been cancelled and the refund will appear in your account within 3-5 business days. You can continue using Circle with a free account.' :
                '\n\nWould you like me to check your refund eligibility?'),
              confidence: 0.95,
              intent: 'refund',
              requiresEscalation: !result.success,
              conversationEnded: result.success
            }
          }

          // Check refund eligibility
          const eligibilityResult = await AdminActionsService.checkRefundEligibility(conversation.userId)
          if (eligibilityResult.success && eligibilityResult.data?.eligible) {
            return {
              message: `${eligibilityResult.message}\n\nWould you like me to process your refund automatically? Just say "yes, process my refund" and I'll handle everything for you right now.`,
              confidence: 0.95,
              intent: 'refund',
              requiresEscalation: false,
              conversationEnded: false
            }
          } else {
            // Use existing refund policy service for ineligible cases
            const refundResponse = await RefundPolicyService.handleRefundRequest(
              lastUserMessage.content,
              conversation.userContext,
              conversation.refundExplanationCount
            )
            if (refundResponse) {
              return refundResponse
            }
          }
        }

        // Handle subscription cancellation
        if (this.isCancellationRequest(messageContent)) {
          const result = await AdminActionsService.cancelSubscription(conversation.userId, 'AI Assistant - User requested cancellation')
          return {
            message: result.message + (result.success ? 
              '\n\nYour subscription will not renew, but you can continue using your premium features until the end of your current billing period.' : ''),
            confidence: 0.95,
            intent: 'cancellation',
            requiresEscalation: !result.success,
            conversationEnded: result.success
          }
        }

        // Handle refund history requests
        if (this.isRefundHistoryRequest(messageContent)) {
          const result = await AdminActionsService.getRefundHistory(conversation.userId)
          return {
            message: result.message + (result.data?.refunds?.length > 0 ? 
              '\n\n' + result.data.refunds.map((r: any) => 
                `• ${r.amount} ${r.currency} - ${r.status} (${new Date(r.requestedAt).toLocaleDateString()})`
              ).join('\n') : ''),
            confidence: 0.95,
            intent: 'refund_history',
            requiresEscalation: false,
            conversationEnded: false
          }
        }
      }

      // Generate AI response using Together AI for other queries
      const aiResponse = await TogetherAIService.generateResponse(
        conversation.messages,
        conversation.userContext
      )

      return aiResponse
    } catch (error) {
      logger.error({ error, conversationId: conversation.id }, 'Error generating AI response')
      
      // Fallback response
      return {
        message: 'I apologize for the technical difficulty. Please contact our support team at contact@orincore.com for assistance.',
        confidence: 0,
        intent: 'error',
        requiresEscalation: true,
        conversationEnded: false
      }
    }
  }

  // Helper methods for intent detection
  private static isSubscriptionInquiry(message: string): boolean {
    const subscriptionKeywords = [
      'subscription', 'plan', 'billing', 'active subscription', 
      'my subscription', 'current plan', 'premium', 'account status'
    ]
    return subscriptionKeywords.some(keyword => message.includes(keyword))
  }

  private static isRefundProcessingRequest(message: string): boolean {
    const processingKeywords = [
      'yes, process my refund', 'process refund', 'yes process', 
      'go ahead', 'do it', 'yes please', 'confirm refund'
    ]
    return processingKeywords.some(keyword => message.includes(keyword))
  }

  private static isCancellationRequest(message: string): boolean {
    const cancellationKeywords = [
      'cancel subscription', 'cancel my subscription', 'stop subscription',
      'end subscription', 'unsubscribe', 'cancel plan'
    ]
    return cancellationKeywords.some(keyword => message.includes(keyword))
  }

  private static isRefundHistoryRequest(message: string): boolean {
    const historyKeywords = [
      'refund history', 'previous refunds', 'past refunds', 
      'refund status', 'my refunds'
    ]
    return historyKeywords.some(keyword => message.includes(keyword))
  }

  // Check if message is a refund request
  private static isRefundRequest(message: string): boolean {
    const refundKeywords = ['refund', 'money back', 'cancel subscription', 'return money', 'get my money']
    const lowerMessage = message.toLowerCase()
    return refundKeywords.some(keyword => lowerMessage.includes(keyword))
  }

  // Get conversation by ID
  static async getConversation(conversationId: string): Promise<Conversation | null> {
    try {
      const { data, error } = await supabase
        .from('ai_conversations')
        .select('*')
        .eq('id', conversationId)
        .single()

      if (error || !data) {
        return null
      }

      return {
        ...data,
        sessionId: data.session_id, // Map session_id to sessionId
        messages: JSON.parse(data.messages || '[]'),
        userContext: JSON.parse(data.user_context || 'null'),
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at)
      }
    } catch (error) {
      logger.error({ error, conversationId }, 'Error getting conversation')
      return null
    }
  }

  // Save conversation to database
  private static async saveConversation(conversation: Conversation): Promise<void> {
    try {
      // Debug logging to check sessionId
      logger.info({ 
        conversationId: conversation.id, 
        sessionId: conversation.sessionId,
        sessionIdType: typeof conversation.sessionId,
        sessionIdLength: conversation.sessionId?.length 
      }, 'Saving conversation with sessionId')

      if (!conversation.sessionId) {
        logger.error({ 
          conversationId: conversation.id, 
          conversation: JSON.stringify(conversation, null, 2) 
        }, 'Missing sessionId in conversation')
        throw new Error('Session ID is required but missing from conversation')
      }

      const conversationData = {
        id: conversation.id,
        user_id: conversation.userId,
        session_id: conversation.sessionId,
        messages: JSON.stringify(conversation.messages),
        status: conversation.status,
        intent: conversation.intent,
        refund_explanation_count: conversation.refundExplanationCount,
        user_context: JSON.stringify(conversation.userContext),
        created_at: conversation.createdAt.toISOString(),
        updated_at: conversation.updatedAt.toISOString()
      }

      logger.info({ 
        conversationData: { ...conversationData, messages: '[MESSAGES]', user_context: '[CONTEXT]' } 
      }, 'Upserting conversation data')

      const { error } = await supabase
        .from('ai_conversations')
        .upsert(conversationData)

      if (error) {
        throw error
      }
    } catch (error) {
      logger.error({ error, conversationId: conversation.id }, 'Error saving conversation')
      throw error
    }
  }

  // Get user context for personalized responses
  private static async getUserContext(userId: string): Promise<any> {
    try {
      // Get user profile
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, email, created_at')
        .eq('id', userId)
        .single()

      // Get user subscriptions
      const { data: subscriptions } = await supabase
        .from('subscriptions')
        .select('plan_type, status, started_at, price_paid, currency')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })

      // Get recent refunds
      const { data: refunds } = await supabase
        .from('refunds')
        .select('status, amount, requested_at')
        .eq('user_id', userId)
        .order('requested_at', { ascending: false })
        .limit(5)

      return {
        profile,
        subscriptions: subscriptions || [],
        refunds: refunds || [],
        hasActiveSubscription: subscriptions?.some(sub => sub.status === 'active') || false,
        latestSubscription: subscriptions?.[0] || null
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user context')
      return null
    }
  }

  // Escalate conversation to email
  static async escalateToEmail(
    conversationId: string,
    userEmail: string,
    escalationReason: string
  ): Promise<ConversationSummary> {
    try {
      const conversation = await this.getConversation(conversationId)
      if (!conversation) {
        throw new Error('Conversation not found')
      }

      // Update conversation status
      conversation.status = 'escalated'
      conversation.updatedAt = new Date()
      await this.saveConversation(conversation)

      // Create conversation summary
      const summary: ConversationSummary = {
        conversationId,
        userQuery: this.extractUserQuery(conversation.messages),
        resolution: 'Escalated to email support',
        escalationReason
      }

      // Send escalation email (implement email service integration)
      await this.sendEscalationEmail(userEmail, conversation, escalationReason)

      return summary
    } catch (error) {
      logger.error({ error, conversationId }, 'Error escalating conversation')
      throw error
    }
  }

  // Extract main user query from conversation
  private static extractUserQuery(messages: AIMessage[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    if (userMessages.length === 0) return 'No user query found'
    
    // Return the first substantial user message
    const substantialMessage = userMessages.find(m => m.content.length > 10)
    return substantialMessage?.content || userMessages[0].content
  }

  // Send escalation email
  private static async sendEscalationEmail(
    userEmail: string,
    conversation: Conversation,
    reason: string
  ): Promise<void> {
    try {
      // Import email service
      const { default: EmailService } = await import('../../services/emailService.js')
      
      const conversationText = conversation.messages
        .map(m => `${m.role.toUpperCase()}: ${m.content}`)
        .join('\n\n')

      const emailContent = `
        Customer Support Escalation
        
        User: ${userEmail}
        Conversation ID: ${conversation.id}
        Escalation Reason: ${reason}
        
        Conversation History:
        ${conversationText}
        
        Please respond to the user at: ${userEmail}
      `

      // Send to support team
      await EmailService.sendSupportEscalation(
        'contact@orincore.com',
        userEmail,
        'AI Support Escalation',
        emailContent
      )
    } catch (error) {
      logger.error({ error, userEmail, conversationId: conversation.id }, 'Error sending escalation email')
    }
  }

  // Get conversation analytics
  static async getConversationAnalytics(days: number = 30): Promise<any> {
    try {
      const startDate = new Date()
      startDate.setDate(startDate.getDate() - days)

      const { data, error } = await supabase
        .from('ai_conversations')
        .select('status, intent, refund_explanation_count, created_at')
        .gte('created_at', startDate.toISOString())

      if (error) throw error

      const analytics = {
        totalConversations: data?.length || 0,
        byStatus: this.groupBy(data || [], 'status'),
        byIntent: this.groupBy(data || [], 'intent'),
        escalationRate: 0,
        averageRefundExplanations: 0
      }

      if (analytics.totalConversations > 0) {
        const escalated = analytics.byStatus.escalated || 0
        analytics.escalationRate = (escalated / analytics.totalConversations) * 100

        const totalExplanations = data?.reduce((sum, conv) => sum + (conv.refund_explanation_count || 0), 0) || 0
        analytics.averageRefundExplanations = totalExplanations / analytics.totalConversations
      }

      return analytics
    } catch (error) {
      logger.error({ error }, 'Error getting conversation analytics')
      throw error
    }
  }

  private static groupBy(array: any[], key: string): Record<string, number> {
    return array.reduce((groups, item) => {
      const group = item[key] || 'unknown'
      groups[group] = (groups[group] || 0) + 1
      return groups
    }, {})
  }

  // Simple token estimation (rough approximation: 1 token ≈ 4 characters)
  private static estimateTokens(text: string): number {
    return Math.ceil(text.length / 4)
  }
}
