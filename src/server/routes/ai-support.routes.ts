import express from 'express'
import { ConversationService } from '../services/ai/conversation.service.js'
import EnhancedConversationService from '../services/ai/enhanced-conversation.service.js'
import { TogetherAIService } from '../services/ai/together-ai.service.js'
import { RefundPolicyService } from '../services/ai/refund-policy.service.js'
import { AdminActionsService } from '../services/ai/admin-actions.service.js'
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

    // Always try to use enhanced conversation service first
    let conversation
    if (userId) {
      try {
        conversation = await EnhancedConversationService.startEnhancedConversation(sessionId, userId, initialMessage)
        //console.log('✅ Started enhanced conversation for user:', userId)
      } catch (error: any) {
        //console.log('❌ Enhanced conversation failed, falling back to basic:', error?.message || error)
        conversation = await ConversationService.startConversation(sessionId, userId, initialMessage)
      }
    } else {
      //console.log('⚠️ No userId provided, using basic conversation service')
      conversation = await ConversationService.startConversation(sessionId, userId, initialMessage)
    }

    res.json({
      success: true,
      conversation: {
        id: conversation.id,
        messages: conversation.messages,
        status: conversation.status,
        intent: conversation.intent,
        ...(userId && 'personality' in conversation ? { personality: conversation.personality } : {})
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

    // Try enhanced conversation service first, fallback to basic service
    let result
    try {
      result = await EnhancedConversationService.addEnhancedMessage(conversationId, message.trim())
      //console.log('✅ Enhanced message processed successfully')
    } catch (enhancedError: any) {
      //console.log('❌ Enhanced message failed:', enhancedError?.message)
      if (enhancedError?.message === 'Conversation not found' || enhancedError?.message?.includes('not found')) {
        // Fallback to basic conversation service
        //console.log('🔄 Falling back to basic conversation service')
        result = await ConversationService.addMessage(conversationId, message.trim())
      } else {
        throw enhancedError
      }
    }

    res.json({
      success: true,
      conversation: {
        id: result.conversation.id,
        messages: result.conversation.messages.slice(-10), // Return last 10 messages
        status: result.conversation.status,
        intent: result.conversation.intent,
        conversationEnded: ('conversationState' in result.conversation) ? result.conversation.conversationState?.conversationEnded || false : false
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

// Process refund (for authenticated users)
router.post('/refund/process', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { reason = 'User requested refund via customer service' } = req.body

    logger.info({ userId, reason }, 'Processing refund request')

    const result = await AdminActionsService.processRefund(userId, reason)

    res.json({
      success: result.success,
      message: result.message,
      data: result.data,
      actionTaken: result.actionTaken
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error processing refund')
    res.status(500).json({ error: 'Failed to process refund' })
  }
})

// Cancel subscription (for authenticated users)
router.post('/subscription/cancel', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { reason = 'User requested cancellation via customer service' } = req.body

    logger.info({ userId, reason }, 'Processing subscription cancellation')

    const result = await AdminActionsService.cancelSubscription(userId, reason)

    res.json({
      success: result.success,
      message: result.message,
      data: result.data,
      actionTaken: result.actionTaken
    })
  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error cancelling subscription')
    res.status(500).json({ error: 'Failed to cancel subscription' })
  }
})

// Check refund eligibility (for authenticated users)
router.get('/refund/eligibility', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    logger.info({ userId }, 'Checking refund eligibility')

    const result = await AdminActionsService.checkRefundEligibility(userId)

    res.json({
      success: result.success,
      eligible: result.data?.eligible || false,
      message: result.message,
      data: result.data
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

// Generate About Me using AI based on user profile data
// This endpoint is public so signup flow can use it before a user is authenticated.
router.post('/generate-about-me', async (req, res) => {
  try {
    const { firstName, age, gender, interests, needs } = req.body

    if (!firstName) {
      return res.status(400).json({ error: 'First name is required' })
    }

    const interestsList = Array.isArray(interests) ? interests.slice(0, 10).join(', ') : ''
    const needsList = Array.isArray(needs) ? needs.slice(0, 5).join(', ') : ''

    const prompt = `Generate a short, engaging, FOMO-inducing "About Me" bio for a connection app profile (like Circle). 

User details:
- Name: ${firstName}
- Age: ${age || 'not specified'}
- Gender: ${gender || 'not specified'}
- Interests: ${interestsList || 'not specified'}
- Looking for: ${needsList || 'not specified'}

Requirements:
- Write in first person as if the user is writing about themselves
- Keep it between 120-220 characters
- Make it feel like a fun FOMO invite to connect (this is a connection app, not a resume)
- Be warm, friendly, and genuine (no clichés, no cringe)
- Naturally weave in 1-3 key interests
- If "Looking for" info is provided, briefly hint what kind of connection they want (friends, dating, situationship, LGBTQ+, etc.)
- Don't mention the name directly
- Make it sound natural, human, and easy to read

Generate ONLY the bio text, nothing else.`

    const response = await fetch('https://api.together.xyz/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.TOGETHER_AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'meta-llama/Llama-3.2-3B-Instruct-Turbo',
        messages: [
          { role: 'system', content: 'You are a helpful assistant that writes authentic, engaging dating app bios. Be concise and genuine.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 200,
        temperature: 0.7
      })
    })

    if (!response.ok) {
      const errorData = await response.text()
      logger.error({ error: errorData }, 'Together AI API error')
      return res.status(500).json({ error: 'Failed to generate bio' })
    }

    const data = await response.json()
    const generatedBio = data.choices[0]?.message?.content?.trim() || ''

    // Clean up the bio - remove quotes if present
    const cleanBio = generatedBio.replace(/^["']|["']$/g, '').trim()

    res.json({
      success: true,
      bio: cleanBio
    })
  } catch (error: any) {
    logger.error({ error }, 'Error generating About Me')
    res.status(500).json({ error: 'Failed to generate bio' })
  }
})

export default router
