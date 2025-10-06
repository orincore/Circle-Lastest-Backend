import express from 'express'
import { ConversationService } from '../services/ai/conversation.service.js'
import { TogetherAIService } from '../services/ai/together-ai.service.js'
import { RefundPolicyService } from '../services/ai/refund-policy.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'
import rateLimit from 'express-rate-limit'

const router = express.Router()

// Rate limiting for AI chat
const chatRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // 50 messages per hour per IP
  message: {
    error: 'Too many messages. Please wait before sending more messages.',
    retryAfter: 3600
  },
  standardHeaders: true,
  legacyHeaders: false
})

// Start a new conversation
router.post('/conversation/start', chatRateLimit, async (req, res) => {
  try {
    const { sessionId, initialMessage, userId } = req.body

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID is required' })
    }

    const conversation = await ConversationService.startConversation(
      sessionId,
      userId,
      initialMessage
    )

    res.json({
      success: true,
      conversation: {
        id: conversation.id,
        messages: conversation.messages,
        status: conversation.status
      }
    })
  } catch (error) {
    logger.error({ error }, 'Error starting conversation')
    res.status(500).json({ error: 'Failed to start conversation' })
  }
})

// Send message to AI
router.post('/conversation/:conversationId/message', chatRateLimit, async (req, res) => {
  try {
    const { conversationId } = req.params
    const { message } = req.body

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' })
    }

    if (message.length > 1000) {
      return res.status(400).json({ error: 'Message too long (max 1000 characters)' })
    }

    const result = await ConversationService.addMessage(conversationId, message.trim())

    res.json({
      success: true,
      conversation: {
        id: result.conversation.id,
        messages: result.conversation.messages.slice(-10), // Return last 10 messages
        status: result.conversation.status
      },
      aiResponse: result.aiResponse
    })
  } catch (error: any) {
    logger.error({ error, conversationId: req.params.conversationId }, 'Error sending message')
    
    if (error?.message === 'Conversation not found') {
      return res.status(404).json({ error: 'Conversation not found' })
    }
    
    if (error?.message === 'Conversation is no longer active' || error?.message === 'Conversation has timed out') {
      return res.status(410).json({ error: error.message })
    }

    res.status(500).json({ error: 'Failed to process message' })
  }
})

// Get conversation history
router.get('/conversation/:conversationId', async (req, res) => {
  try {
    const { conversationId } = req.params
    const conversation = await ConversationService.getConversation(conversationId)

    if (!conversation) {
      return res.status(404).json({ error: 'Conversation not found' })
    }

    res.json({
      success: true,
      conversation: {
        id: conversation.id,
        messages: conversation.messages,
        status: conversation.status,
        intent: conversation.intent,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt
      }
    })
  } catch (error) {
    logger.error({ error, conversationId: req.params.conversationId }, 'Error getting conversation')
    res.status(500).json({ error: 'Failed to get conversation' })
  }
})

// Escalate conversation to email
router.post('/conversation/:conversationId/escalate', async (req, res) => {
  try {
    const { conversationId } = req.params
    const { userEmail, reason } = req.body

    if (!userEmail || !reason) {
      return res.status(400).json({ error: 'User email and reason are required' })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(userEmail)) {
      return res.status(400).json({ error: 'Invalid email format' })
    }

    const summary = await ConversationService.escalateToEmail(
      conversationId,
      userEmail,
      reason
    )

    res.json({
      success: true,
      message: 'Your conversation has been escalated to our support team. You should receive a response at ' + userEmail + ' within 24 hours.',
      summary
    })
  } catch (error) {
    logger.error({ error, conversationId: req.params.conversationId }, 'Error escalating conversation')
    res.status(500).json({ error: 'Failed to escalate conversation' })
  }
})

// Check refund eligibility (for authenticated users)
router.get('/refund/eligibility', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    // Get user's latest subscription
    const { supabase } = await import('../config/supabase.js')
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select('started_at, plan_type, price_paid, currency, status')
      .eq('user_id', userId)
      .eq('status', 'active')
      .order('started_at', { ascending: false })
      .limit(1)
      .single()

    if (error || !subscription) {
      return res.json({
        success: true,
        eligible: false,
        message: 'No active subscription found'
      })
    }

    const eligibility = RefundPolicyService.validateRefundEligibility(subscription.started_at)

    res.json({
      success: true,
      eligible: eligibility.eligible,
      daysRemaining: eligibility.daysRemaining,
      message: eligibility.message,
      subscription: {
        planType: subscription.plan_type,
        startDate: subscription.started_at,
        amount: subscription.price_paid,
        currency: subscription.currency
      }
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error checking refund eligibility')
    res.status(500).json({ error: 'Failed to check refund eligibility' })
  }
})

// Get AI service status
router.get('/status', async (req, res) => {
  try {
    const isConnected = await TogetherAIService.validateConnection()
    
    res.json({
      success: true,
      status: isConnected ? 'operational' : 'degraded',
      aiService: isConnected ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error({ error }, 'Error checking AI service status')
    res.status(500).json({ 
      success: false,
      status: 'error',
      error: 'Failed to check service status'
    })
  }
})

// Admin: Get conversation analytics
router.get('/admin/analytics', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { days = 30 } = req.query
    const analytics = await ConversationService.getConversationAnalytics(parseInt(days as string))

    res.json({
      success: true,
      analytics
    })
  } catch (error) {
    logger.error({ error }, 'Error getting conversation analytics')
    res.status(500).json({ error: 'Failed to get analytics' })
  }
})

// Admin: Get available AI models with cost info
router.get('/admin/models', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const models = await TogetherAIService.getAvailableModels()
    const currentModel = TogetherAIService.getModelInfo()

    res.json({
      success: true,
      models,
      currentModel,
      costOptimization: {
        estimatedCostPer1kTokens: currentModel.estimatedCostPer1kTokens,
        maxTokensPerResponse: currentModel.maxTokens,
        temperature: currentModel.temperature
      }
    })
  } catch (error: any) {
    logger.error({ error }, 'Error getting AI models')
    res.status(500).json({ error: 'Failed to get AI models' })
  }
})

// Admin: Get cost analytics
router.get('/admin/cost-analytics', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const { days = 30 } = req.query
    const analytics = await ConversationService.getConversationAnalytics(parseInt(days as string))
    
    // Add cost estimates
    const modelInfo = TogetherAIService.getModelInfo()
    const estimatedTotalCost = analytics.totalConversations * 0.001 // Rough estimate
    
    res.json({
      success: true,
      costAnalytics: {
        ...analytics,
        estimatedTotalCost,
        costPerConversation: estimatedTotalCost / (analytics.totalConversations || 1),
        modelInfo,
        period: `${days} days`
      }
    })
  } catch (error: any) {
    logger.error({ error }, 'Error getting cost analytics')
    res.status(500).json({ error: 'Failed to get cost analytics' })
  }
})

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'AI Customer Support',
    status: 'healthy',
    timestamp: new Date().toISOString()
  })
})

export default router
