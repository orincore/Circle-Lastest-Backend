import { supabase } from '../../config/supabase.js'
import { logger } from '../../config/logger.js'
import { TogetherAIService, type AIMessage as BaseAIMessage, type AIResponse } from './together-ai.service.js'
import { AdminActionsService } from './admin-actions.service.js'
import { RefundPolicyService } from './refund-policy.service.js'
import PersonalityService, { type AIPersonality, type ConversationState } from './personality.service.js'
import SentimentAnalysisService, { type SentimentAnalysis } from './sentiment-analysis.service.js'
import ProactiveSupportService from './proactive-support.service.js'
import MultilingualSupportService from './multilingual-support.service.js'
import EscalationSystemService from './escalation-system.service.js'
import SatisfactionTrackingService from './satisfaction-tracking.service.js'

export interface EnhancedAIMessage extends BaseAIMessage {
  cost?: number
}

export interface EnhancedConversation {
  id: string
  userId?: string
  sessionId: string
  messages: EnhancedAIMessage[]
  status: 'active' | 'escalated' | 'resolved' | 'abandoned'
  intent: string
  refundExplanationCount: number
  estimatedCost: number
  userContext: any
  createdAt: Date
  updatedAt: Date
  // Enhanced fields
  personality: AIPersonality
  conversationState: ConversationState
  pendingMessages: string[]
  lastTypingStart?: Date
}

export interface EnhancedAIResponse extends AIResponse {
  multiPart?: boolean
  messages?: string[]
  typingDelay?: number
  shouldShowTyping?: boolean
  cost?: number
  sentimentAnalysis?: SentimentAnalysis
  escalationDecision?: any
  satisfactionSurveyId?: string
  detectedLanguage?: string
  proactiveAlerts?: any[]
}

export class EnhancedConversationService {
  // Start enhanced conversation with personality
  static async startEnhancedConversation(
    sessionId: string,
    userId?: string,
    initialMessage?: string
  ): Promise<EnhancedConversation> {
    try {
      const personality = PersonalityService.generatePersonality()
      const conversationState: ConversationState = {
        askedAnythingElse: false,
        userSaidNo: false,
        conversationEnded: false,
        messageCount: 0,
        lastResponseTime: Date.now()
      }

      const conversation: EnhancedConversation = {
        id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        userId,
        sessionId,
        messages: [],
        status: 'active',
        intent: 'general',
        refundExplanationCount: 0,
        estimatedCost: 0,
        userContext: userId ? await this.getUserContext(userId) : null,
        createdAt: new Date(),
        updatedAt: new Date(),
        personality,
        conversationState,
        pendingMessages: []
      }

      // Add initial greeting
      const greetingMessage: EnhancedAIMessage = {
        role: 'assistant',
        content: personality.greeting,
        timestamp: new Date(),
        cost: 0
      }
      conversation.messages.push(greetingMessage)

      // Add initial user message if provided
      if (initialMessage) {
        const userMessage: EnhancedAIMessage = {
          role: 'user',
          content: initialMessage,
          timestamp: new Date()
        }
        conversation.messages.push(userMessage)
        
        // Generate AI response
        const aiResponse = await this.generateEnhancedAIResponse(conversation)
        if (aiResponse.messages && aiResponse.messages.length > 0) {
          for (const msg of aiResponse.messages) {
            conversation.messages.push({
              role: 'assistant',
              content: msg,
              timestamp: new Date(),
              cost: aiResponse.cost || 0
            })
          }
        } else {
          conversation.messages.push({
            role: 'assistant',
            content: aiResponse.message,
            timestamp: new Date(),
            cost: aiResponse.cost || 0
          })
        }

        conversation.intent = aiResponse.intent
        conversation.estimatedCost += aiResponse.cost || 0
        conversation.conversationState.messageCount++
      }

      await this.saveEnhancedConversation(conversation)
      return conversation
    } catch (error) {
      logger.error({ error, sessionId, userId }, 'Error starting enhanced conversation')
      throw error
    }
  }

  // Add message with enhanced processing
  static async addEnhancedMessage(
    conversationId: string,
    message: string
  ): Promise<{ conversation: EnhancedConversation; aiResponse: EnhancedAIResponse }> {
    try {
      const conversation = await this.getEnhancedConversation(conversationId)
      if (!conversation) {
        throw new Error('Conversation not found')
      }

      // Check if conversation is ended
      if (conversation.conversationState.conversationEnded) {
        throw new Error('Conversation has ended')
      }

      // Add user message
      const userMessage: EnhancedAIMessage = {
        role: 'user',
        content: message,
        timestamp: new Date()
      }
      conversation.messages.push(userMessage)

      // Check if user wants to end conversation
      if (conversation.conversationState.askedAnythingElse && 
          PersonalityService.isConversationEnding(message)) {
        
        conversation.conversationState.userSaidNo = true
        conversation.conversationState.conversationEnded = true
        conversation.status = 'resolved'

        const closingMessage = PersonalityService.generateClosingMessage(conversation.personality)
        const aiMessage: EnhancedAIMessage = {
          role: 'assistant',
          content: closingMessage,
          timestamp: new Date(),
          cost: 0
        }
        conversation.messages.push(aiMessage)

        await this.saveEnhancedConversation(conversation)
        
        return {
          conversation,
          aiResponse: {
            message: closingMessage,
            confidence: 1.0,
            intent: 'conversation_end',
            requiresEscalation: false,
            conversationEnded: true,
            typingDelay: PersonalityService.calculateResponseDelay(closingMessage.length, conversation.conversationState)
          }
        }
      }

      // Generate AI response
      const aiResponse = await this.generateEnhancedAIResponse(conversation)
      
      // Add AI messages
      if (aiResponse.messages && aiResponse.messages.length > 0) {
        for (const msg of aiResponse.messages) {
          conversation.messages.push({
            role: 'assistant',
            content: msg,
            timestamp: new Date(),
            cost: (aiResponse.cost || 0) / aiResponse.messages.length
          })
        }
      } else {
        conversation.messages.push({
          role: 'assistant',
          content: aiResponse.message,
          timestamp: new Date(),
          cost: aiResponse.cost || 0
        })
      }

      // Update conversation state
      conversation.intent = aiResponse.intent
      conversation.estimatedCost += aiResponse.cost || 0
      conversation.conversationState.messageCount++
      conversation.conversationState.lastResponseTime = Date.now()
      conversation.updatedAt = new Date()

      // Check if we should ask "anything else"
      if (!conversation.conversationState.askedAnythingElse && 
          conversation.conversationState.messageCount >= 2 &&
          !aiResponse.requiresEscalation &&
          aiResponse.intent !== 'error') {
        
        conversation.conversationState.askedAnythingElse = true
        const anythingElseQuestion = PersonalityService.generateAnythingElseQuestion()
        
        // Add the question as a separate message
        conversation.messages.push({
          role: 'assistant',
          content: anythingElseQuestion,
          timestamp: new Date(),
          cost: 0
        })

        // Add to response messages if multi-part
        if (aiResponse.messages) {
          aiResponse.messages.push(anythingElseQuestion)
        } else {
          aiResponse.messages = [aiResponse.message, anythingElseQuestion]
          aiResponse.multiPart = true
        }
      }

      await this.saveEnhancedConversation(conversation)
      return { conversation, aiResponse }
    } catch (error) {
      logger.error({ error, conversationId, message }, 'Error adding enhanced message')
      throw error
    }
  }

  // Generate enhanced AI response with personality and human behavior
  private static async generateEnhancedAIResponse(conversation: EnhancedConversation): Promise<EnhancedAIResponse> {
    try {
      const lastUserMessage = conversation.messages
        .filter(m => m.role === 'user')
        .slice(-1)[0]

      if (!lastUserMessage) {
        throw new Error('No user message found')
      }

      const messageContent = lastUserMessage.content.toLowerCase()
      let response: EnhancedAIResponse | undefined

      // 1. SENTIMENT ANALYSIS - Analyze user's emotional state
      const sentimentAnalysis = SentimentAnalysisService.analyzeSentiment(
        lastUserMessage.content,
        {
          messageHistory: conversation.messages.map(m => m.content),
          issueType: conversation.intent,
          resolutionAttempts: conversation.messages.filter(m => m.role === 'assistant').length,
          customerTier: conversation.userContext?.latestSubscription?.plan_type || 'free',
          previousInteractions: 0
        }
      )

      // 2. LANGUAGE DETECTION - Detect user's language
      const languageDetection = MultilingualSupportService.detectLanguage(lastUserMessage.content)

      // 3. PROACTIVE SUPPORT - Check for potential issues
      let proactiveAlerts: any[] = []
      if (conversation.userId) {
        proactiveAlerts = await ProactiveSupportService.detectPotentialIssues(conversation.userId)
      }

      // 4. ESCALATION EVALUATION - Check if escalation is needed
      const conversationHistory = conversation.messages.map(m => m.content)
      const escalationDecision = await EscalationSystemService.evaluateEscalation(
        conversation.id,
        conversation.userId || '',
        lastUserMessage.content,
        conversationHistory,
        conversation.userContext?.latestSubscription?.plan_type || 'free'
      )

      // Handle admin actions if user is authenticated
      if (conversation.userId) {
        // Check subscription status with empathy
        if (this.isSubscriptionInquiry(messageContent)) {
          const result = await AdminActionsService.checkSubscriptionStatus(conversation.userId)
          const empathicIntro = PersonalityService.generateEmpathicResponse('subscription_inquiry', lastUserMessage.content, conversation.personality, result.success)
          
          response = {
            message: empathicIntro + result.message + (result.data?.hasActiveSubscription ? 
              `\n\nYour ${result.data.activeSubscription.plan_type} plan costs ${result.data.activeSubscription.price_paid} ${result.data.activeSubscription.currency} and started on ${new Date(result.data.activeSubscription.started_at).toLocaleDateString()}.` : 
              '\n\nWould you like me to help you upgrade to a premium plan?'),
            confidence: 0.95,
            intent: 'subscription_inquiry',
            requiresEscalation: false,
            conversationEnded: false
          }
        }
        // Handle refund requests with empathy
        else if (this.isRefundRequest(messageContent)) {
          if (this.isRefundProcessingRequest(messageContent)) {
            const empathicIntro = PersonalityService.generateEmpathicResponse('refund_processing', lastUserMessage.content, conversation.personality)
            const result = await AdminActionsService.processRefund(conversation.userId, 'AI Assistant - User requested refund')
            
            response = {
              message: empathicIntro + result.message + (result.success ? 
                '\n\nYour subscription has been cancelled and the refund will appear in your account within 3-5 business days. You can continue using Circle with a free account.' :
                '\n\nLet me check your refund eligibility for you.'),
              confidence: 0.95,
              intent: 'refund',
              requiresEscalation: !result.success,
              conversationEnded: result.success
            }
          } else {
            const eligibilityResult = await AdminActionsService.checkRefundEligibility(conversation.userId)
            const empathicIntro = PersonalityService.generateEmpathicResponse('refund_inquiry', lastUserMessage.content, conversation.personality, eligibilityResult.success)
            
            if (eligibilityResult.success && eligibilityResult.data?.eligible) {
              response = {
                message: empathicIntro + `${eligibilityResult.message}\n\nI can process your refund right now if you'd like. Just let me know if you'd like me to go ahead with the refund, and I'll take care of everything for you.`,
                confidence: 0.95,
                intent: 'refund',
                requiresEscalation: false,
                conversationEnded: false
              }
            } else {
              const refundResponse = await RefundPolicyService.handleRefundRequest(
                lastUserMessage.content,
                conversation.userContext,
                conversation.refundExplanationCount
              )
              if (refundResponse) {
                response = {
                  ...refundResponse,
                  message: empathicIntro + refundResponse.message
                }
              }
            }
          }
        }
        // Handle subscription cancellation with automatic refund logic
        else if (this.isCancellationRequest(messageContent)) {
          const empathicIntro = PersonalityService.generateEmpathicResponse('cancellation', lastUserMessage.content, conversation.personality)
          const eligibilityResult = await AdminActionsService.checkRefundEligibility(conversation.userId)
          
          if (eligibilityResult.success && eligibilityResult.data?.eligible) {
            const refundResult = await AdminActionsService.processRefund(conversation.userId, 'AI Assistant - Cancellation with refund (within 7 days)')
            
            response = {
              message: empathicIntro + (refundResult.success ? 
                `I've taken care of both your cancellation and refund since you subscribed within the last 7 days. Your refund of ${refundResult.data?.amount} ${refundResult.data?.currency} will appear in your account within 3-5 business days.\n\nYou can continue using Circle with a free account, and I'm here if you need any assistance in the future.` :
                `I've processed your cancellation request, but there was an issue with the refund. Let me connect you with our billing specialist to ensure your refund is processed correctly.`),
              confidence: 0.95,
              intent: 'cancellation_with_refund',
              requiresEscalation: !refundResult.success,
              conversationEnded: refundResult.success
            }
          } else {
            const result = await AdminActionsService.cancelSubscription(conversation.userId, 'AI Assistant - User requested cancellation')
            response = {
              message: empathicIntro + (result.success ? 
                `I've successfully cancelled your subscription. Since your subscription is older than 7 days, our refund policy doesn't allow for a refund, but your premium features will remain active until the end of your current billing period.\n\nIs there anything else I can help you with regarding your account?` :
                result.message),
              confidence: 0.95,
              intent: 'cancellation',
              requiresEscalation: !result.success,
              conversationEnded: result.success
            }
          }
        }
        // Handle refund history requests
        else if (this.isRefundHistoryRequest(messageContent)) {
          const empathicIntro = PersonalityService.generateEmpathicResponse('refund_history', lastUserMessage.content, conversation.personality)
          const result = await AdminActionsService.getRefundHistory(conversation.userId)
          
          response = {
            message: empathicIntro + result.message + (result.data?.refunds?.length > 0 ? 
              '\n\nHere are your refund details:\n' + result.data.refunds.map((r: any) => 
                `• ${r.amount} ${r.currency} - ${r.status} (${new Date(r.requestedAt).toLocaleDateString()})`
              ).join('\n') : ''),
            confidence: 0.95,
            intent: 'refund_history',
            requiresEscalation: false,
            conversationEnded: false
          }
        }
      }

      // 5. HANDLE ESCALATION - If escalation is needed, route to human
      if (escalationDecision.shouldEscalate) {
        const escalationMessage = `I understand this is ${escalationDecision.priority} priority. Let me connect you with one of our specialist team members who can provide the best assistance for your situation. ${escalationDecision.assignedAgent ? `You'll be speaking with a specialist shortly.` : `Your estimated wait time is ${escalationDecision.estimatedWaitTime} minutes.`}`
        
        response = {
          message: escalationMessage,
          confidence: 0.95,
          intent: 'escalation',
          requiresEscalation: true,
          conversationEnded: false,
          sentimentAnalysis,
          escalationDecision,
          detectedLanguage: languageDetection.language,
          proactiveAlerts
        }
      }

      // 6. PROACTIVE ALERTS - Address any proactive issues detected
      if (!response && proactiveAlerts.length > 0) {
        const highPriorityAlert = proactiveAlerts.find(alert => alert.severity === 'high' || alert.severity === 'critical')
        if (highPriorityAlert) {
          const proactiveMessage = ProactiveSupportService.generateProactiveMessage(highPriorityAlert, conversation.personality.name)
          response = {
            message: proactiveMessage,
            confidence: 0.9,
            intent: 'proactive_support',
            requiresEscalation: false,
            conversationEnded: false,
            sentimentAnalysis,
            proactiveAlerts
          }
        }
      }

      // If no specific admin action, use Together AI
      if (!response) {
        const aiResponse = await TogetherAIService.generateResponse(
          conversation.messages,
          conversation.userContext
        )
        
        // Generate empathetic response based on sentiment
        const empathicIntro = SentimentAnalysisService.generateEmpathicResponse(sentimentAnalysis, conversation.personality.name)
        response = {
          ...aiResponse,
          message: empathicIntro + aiResponse.message,
          sentimentAnalysis,
          detectedLanguage: languageDetection.language,
          proactiveAlerts
        }
      }

      // Add human-like behavior
      const messageLength = response.message.length
      response.typingDelay = PersonalityService.calculateResponseDelay(messageLength, conversation.conversationState)
      response.shouldShowTyping = true

      // Split into multiple messages if needed
      const messageParts = PersonalityService.generateMultiPartResponse(response.message, conversation.personality)
      if (messageParts.length > 1) {
        response.multiPart = true
        response.messages = messageParts
      }

      // 7. MULTILINGUAL SUPPORT - Translate response if needed
      if (languageDetection.language !== 'en' && MultilingualSupportService.isLanguageSupported(languageDetection.language)) {
        const multilingualResponse = await MultilingualSupportService.generateMultilingualResponse(
          lastUserMessage.content,
          response.message,
          languageDetection.language
        )
        
        if (multilingualResponse.supportedLanguage) {
          response.message = multilingualResponse.responseInOriginal
          response.detectedLanguage = multilingualResponse.originalLanguage
        }
      }

      // 8. SATISFACTION TRACKING - Create survey if conversation is ending
      if (response.conversationEnded || conversation.conversationState.conversationEnded) {
        try {
          const survey = await SatisfactionTrackingService.createSatisfactionSurvey(conversation.id)
          response.satisfactionSurveyId = survey.id
        } catch (error) {
          logger.warn({ error, conversationId: conversation.id }, 'Failed to create satisfaction survey')
        }
      }

      // Format with personality
      if (response.messages) {
        response.messages = response.messages.map(msg => 
          PersonalityService.formatResponse(msg, conversation.personality, conversation.conversationState)
        )
      } else {
        response.message = PersonalityService.formatResponse(response.message, conversation.personality, conversation.conversationState)
      }

      return response
    } catch (error) {
      logger.error({ error, conversationId: conversation.id }, 'Error generating enhanced AI response')
      
      const empathicIntro = PersonalityService.generateEmpathicResponse('error', '', conversation.personality, false)
      return {
        message: empathicIntro + 'I\'m experiencing some technical difficulties right now. Let me connect you with one of our human support specialists who can assist you immediately.',
        confidence: 0,
        intent: 'error',
        requiresEscalation: true,
        conversationEnded: false,
        typingDelay: 2000
      }
    }
  }

  // Helper methods (same as original but with enhanced detection)
  private static isSubscriptionInquiry(message: string): boolean {
    const subscriptionKeywords = [
      'subscription', 'plan', 'billing', 'active subscription', 
      'my subscription', 'current plan', 'premium', 'account status',
      'what plan', 'which plan', 'subscription details'
    ]
    return subscriptionKeywords.some(keyword => message.includes(keyword))
  }

  private static isRefundRequest(message: string): boolean {
    const refundKeywords = [
      'refund', 'money back', 'return money', 'get my money',
      'want my money back', 'refund request', 'request refund'
    ]
    const lowerMessage = message.toLowerCase()
    return refundKeywords.some(keyword => lowerMessage.includes(keyword))
  }

  private static isRefundProcessingRequest(message: string): boolean {
    const processingKeywords = [
      'yes, process my refund', 'process refund', 'yes process', 
      'go ahead', 'do it', 'yes please', 'confirm refund', 'proceed with refund'
    ]
    return processingKeywords.some(keyword => message.includes(keyword))
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
      'refund status', 'my refunds', 'refund details'
    ]
    return historyKeywords.some(keyword => message.includes(keyword))
  }

  // Database operations
  private static async getUserContext(userId: string): Promise<any> {
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('username, email, created_at')
        .eq('id', userId)
        .single()

      const { data: subscriptions } = await supabase
        .from('subscriptions')
        .select('plan_type, status, started_at, price_paid, currency')
        .eq('user_id', userId)
        .order('started_at', { ascending: false })

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

  private static async saveEnhancedConversation(conversation: EnhancedConversation): Promise<void> {
    try {
      if (!conversation.sessionId) {
        throw new Error('Missing sessionId in conversation')
      }

      const { error } = await supabase
        .from('ai_conversations')
        .upsert({
          id: conversation.id,
          user_id: conversation.userId,
          session_id: conversation.sessionId,
          messages: JSON.stringify(conversation.messages),
          status: conversation.status,
          intent: conversation.intent,
          refund_explanation_count: conversation.refundExplanationCount,
          estimated_cost: conversation.estimatedCost,
          user_context: JSON.stringify(conversation.userContext),
          personality: JSON.stringify(conversation.personality),
          conversation_state: JSON.stringify(conversation.conversationState),
          created_at: conversation.createdAt.toISOString(),
          updated_at: conversation.updatedAt.toISOString()
        })

      if (error) {
        throw error
      }
    } catch (error) {
      logger.error({ error, conversationId: conversation.id }, 'Error saving enhanced conversation')
      throw error
    }
  }

  private static async getEnhancedConversation(conversationId: string): Promise<EnhancedConversation | null> {
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
        sessionId: data.session_id,
        messages: JSON.parse(data.messages || '[]'),
        userContext: JSON.parse(data.user_context || 'null'),
        personality: JSON.parse(data.personality || '{}'),
        conversationState: JSON.parse(data.conversation_state || '{}'),
        pendingMessages: [],
        createdAt: new Date(data.created_at),
        updatedAt: new Date(data.updated_at)
      }
    } catch (error) {
      logger.error({ error, conversationId }, 'Error getting enhanced conversation')
      return null
    }
  }
}

export default EnhancedConversationService
