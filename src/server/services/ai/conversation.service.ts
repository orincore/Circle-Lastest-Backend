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
        // Handle cancellation confirmation (must be before general cancellation check)
        if (this.isCancellationConfirmation(messageContent)) {
          const eligibilityResult = await AdminActionsService.checkRefundEligibility(conversation.userId)
          
          if (eligibilityResult.success && eligibilityResult.data?.eligible) {
            // Process refund for cancellations within 7 days
            const result = await AdminActionsService.processRefund(conversation.userId, 'AI Assistant - User confirmed cancellation with refund')
            return {
              message: result.success ? 
                `✅ **Cancellation and Refund Processed Successfully!**

Your subscription has been cancelled and your refund is being processed.

📧 **Confirmation Email Sent**
You'll receive a confirmation email with:
• Refund details and amount
• Expected refund timeline (3-5 business days)
• Cancellation confirmation

💰 **Refund Details:**
• Amount: ${result.data?.amount} ${result.data?.currency}
• Refund ID: ${result.data?.refundId}
• Processing time: 3-5 business days

🎉 **What's Next:**
• You can continue using Circle with a free account
• Your premium features are now deactivated
• No future charges will be made

Is there anything else I can help you with?` :
                `I encountered an issue processing your refund. Please contact our support team at contact@orincore.com for immediate assistance.`,
              confidence: 0.95,
              intent: 'refund_processed',
              requiresEscalation: !result.success,
              conversationEnded: result.success
            }
          } else {
            // Cancel without refund (after 7 days)
            const result = await AdminActionsService.cancelSubscription(conversation.userId, 'AI Assistant - User confirmed cancellation')
            return {
              message: result.success ? 
                `✅ **Subscription Cancelled Successfully!**

Your subscription has been cancelled as requested.

📧 **Confirmation Email Sent**
You'll receive a confirmation email with cancellation details.

ℹ️ **Important Information:**
• Your premium features remain active until the end of your current billing period
• No refund is available (subscription is older than 7 days)
• Your subscription will NOT auto-renew
• No future charges will be made

🎉 **What's Next:**
• Continue enjoying premium features until your billing period ends
• After that, you'll automatically switch to a free account
• You can resubscribe anytime if you change your mind

Is there anything else I can help you with?` :
                `I encountered an issue cancelling your subscription. Please contact our support team at contact@orincore.com for assistance.`,
              confidence: 0.95,
              intent: 'cancellation_processed',
              requiresEscalation: !result.success,
              conversationEnded: result.success
            }
          }
        }

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

          // Check refund eligibility and provide detailed information
          const eligibilityResult = await AdminActionsService.checkRefundEligibility(conversation.userId)
          const subscriptionResult = await AdminActionsService.checkSubscriptionStatus(conversation.userId)
          
          if (eligibilityResult.success && eligibilityResult.data?.eligible) {
            const { daysSinceStart, subscription, refundAmount, currency } = eligibilityResult.data
            return {
              message: `I can help you with a refund! Here's your subscription information:

📋 **Subscription Details:**
• Plan: ${subscription.plan_type}
• Amount Paid: ${refundAmount} ${currency}
• Started: ${new Date(subscription.started_at).toLocaleDateString()}
• Days Since Start: ${daysSinceStart} days

✅ **Refund Eligibility:** You are eligible for a full refund!
• Our refund policy allows refunds within 7 days of subscription
• You subscribed ${daysSinceStart} days ago (within the 7-day window)
• Refund amount: ${refundAmount} ${currency}

💡 **What happens next:**
1. Your subscription will be cancelled immediately
2. You'll receive a full refund of ${refundAmount} ${currency}
3. Refund will appear in 3-5 business days
4. You can continue using Circle with a free account

Would you like me to process your refund now? Just say "yes, process my refund" and I'll handle everything for you.`,
              confidence: 0.95,
              intent: 'refund',
              requiresEscalation: false,
              conversationEnded: false
            }
          } else {
            // Provide detailed information for ineligible refunds
            const { daysSinceStart, subscription } = eligibilityResult.data || {}
            return {
              message: `I understand you'd like a refund. Let me check your subscription details:

📋 **Subscription Information:**
${subscription ? `• Plan: ${subscription.plan_type}
• Amount Paid: ${subscription.price_paid} ${subscription.currency}
• Started: ${new Date(subscription.started_at).toLocaleDateString()}
• Days Since Start: ${daysSinceStart} days` : '• No active subscription found'}

❌ **Refund Eligibility:** Unfortunately, you're not eligible for a refund.
• Our refund policy allows refunds within 7 days of subscription
${daysSinceStart ? `• You subscribed ${daysSinceStart} days ago (outside the 7-day window)` : ''}

📝 **Your Options:**
1. **Cancel Subscription:** I can cancel your subscription so it won't renew, but you'll keep access until the end of your billing period
2. **Contact Support:** For special circumstances, you can contact our support team at contact@orincore.com

Would you like me to cancel your subscription for you?`,
              confidence: 0.95,
              intent: 'refund_ineligible',
              requiresEscalation: false,
              conversationEnded: false
            }
          }
        }

        // Handle subscription cancellation with automatic refund if eligible
        if (this.isCancellationRequest(messageContent)) {
          // First check if user is eligible for refund (within 7 days)
          const eligibilityResult = await AdminActionsService.checkRefundEligibility(conversation.userId)
          const subscriptionResult = await AdminActionsService.checkSubscriptionStatus(conversation.userId)
          
          if (!subscriptionResult.success || !subscriptionResult.data?.hasActiveSubscription) {
            return {
              message: `I checked your account and you don't have an active subscription to cancel. You're currently using Circle with a free account.

If you have any other questions or need help with something else, I'm here to assist!`,
              confidence: 0.95,
              intent: 'no_subscription',
              requiresEscalation: false,
              conversationEnded: false
            }
          }
          
          if (eligibilityResult.success && eligibilityResult.data?.eligible) {
            const { daysSinceStart, subscription, refundAmount, currency } = eligibilityResult.data
            
            return {
              message: `I can help you cancel your subscription! Since you subscribed recently, you're eligible for a full refund.

📋 **Your Subscription:**
• Plan: ${subscription.plan_type}
• Amount Paid: ${refundAmount} ${currency}
• Started: ${new Date(subscription.started_at).toLocaleDateString()} (${daysSinceStart} days ago)

✅ **Good News:** You're within our 7-day refund window!

💡 **If I cancel now:**
1. Your subscription will be cancelled immediately
2. You'll receive a FULL REFUND of ${refundAmount} ${currency}
3. Refund will appear in 3-5 business days
4. You can continue using Circle with a free account

Would you like me to proceed with the cancellation and refund? Just say "yes, cancel and refund" to confirm.`,
              confidence: 0.95,
              intent: 'cancellation_with_refund_available',
              requiresEscalation: false,
              conversationEnded: false
            }
          } else {
            // Regular cancellation without refund (after 7 days)
            const { daysSinceStart, subscription } = eligibilityResult.data || {}
            
            return {
              message: `I can help you cancel your subscription. Let me explain what will happen:

📋 **Your Subscription:**
• Plan: ${subscription?.plan_type || 'Unknown'}
• Started: ${subscription ? new Date(subscription.started_at).toLocaleDateString() : 'Unknown'} (${daysSinceStart || 'Unknown'} days ago)

ℹ️ **Refund Status:** No refund available
• Our refund policy allows refunds within 7 days of subscription
• You subscribed ${daysSinceStart || 'more than 7'} days ago (outside the refund window)

💡 **If I cancel now:**
1. Your subscription will be cancelled
2. You'll keep premium access until the end of your current billing period
3. Your subscription will NOT auto-renew
4. No charges will be made after the current period ends

Would you like me to proceed with the cancellation? Say "yes, cancel my subscription" to confirm.`,
              confidence: 0.95,
              intent: 'cancellation_no_refund',
              requiresEscalation: false,
              conversationEnded: false
            }
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
      'go ahead', 'do it', 'yes please', 'confirm refund',
      'yes, cancel and refund', 'cancel and refund', 'proceed with refund',
      'yes refund', 'process it', 'yes do it'
    ]
    return processingKeywords.some(keyword => message.includes(keyword))
  }

  private static isCancellationConfirmation(message: string): boolean {
    const confirmationKeywords = [
      'yes, cancel my subscription', 'yes cancel', 'confirm cancellation',
      'proceed with cancellation', 'yes, cancel and refund', 'cancel and refund',
      'yes cancel and refund', 'confirm cancel', 'yes please cancel'
    ]
    return confirmationKeywords.some(keyword => message.includes(keyword))
  }

  private static isCancellationRequest(message: string): boolean {
    const cancellationKeywords = [
      'cancel subscription', 'cancel my subscription', 'stop subscription',
      'end subscription', 'unsubscribe', 'cancel plan', 'cancel my plan',
      'i want to cancel', 'please cancel', 'cancel service', 'stop billing',
      'discontinue subscription', 'terminate subscription', 'end my subscription',
      'stop my subscription', 'cancel account', 'close subscription'
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
    const lowerMessage = message.toLowerCase().trim()
    
    // Negative patterns - user doesn't want refund
    // Only match if these are the primary intent, not just containing "no"
    const negativePatterns = [
      "don't want refund",
      "don't need refund",
      "skip refund",
      "no thanks",
      "i don't want"
    ]
    
    // Check for negative patterns - but only if they're not followed by positive intent
    const hasNegativeIntent = negativePatterns.some(pattern => lowerMessage.includes(pattern))
    const hasPositiveRefundIntent = lowerMessage.includes('want refund') || 
                                     lowerMessage.includes('need refund') ||
                                     lowerMessage.includes('i want my')
    
    // If there's positive intent, ignore negative patterns
    if (hasNegativeIntent && !hasPositiveRefundIntent) {
      return false
    }
    
    // Positive refund request patterns
    const refundKeywords = [
      'refund',
      'money back',
      'return money',
      'get my money',
      'want refund',
      'need refund',
      'i want my refund',
      'want my refund',
      'need my refund',
      'get refund',
      'request refund',
      'give me refund',
      'my money back'
    ]
    
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
