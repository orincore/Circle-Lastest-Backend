import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { ConversationService } from '../services/ai/conversation.service.js'
import { AdminActionsService } from '../services/ai/admin-actions.service.js'
import EnhancedConversationService from '../services/ai/enhanced-conversation.service.js'
import SatisfactionTrackingService from '../services/ai/satisfaction-tracking.service.js'
import AnalyticsInsightsService from '../services/ai/analytics-insights.service.js'
import ProactiveSupportService from '../services/ai/proactive-support.service.js'
import EscalationSystemService from '../services/ai/escalation-system.service.js'
import MultilingualSupportService from '../services/ai/multilingual-support.service.js'
import { logger } from '../config/logger.js'

const router = Router()

// Test endpoint for AI admin capabilities
router.post('/test-admin-actions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { action } = req.body

    let result
    switch (action) {
      case 'check_subscription':
        result = await AdminActionsService.checkSubscriptionStatus(userId)
        break
      case 'check_refund_eligibility':
        result = await AdminActionsService.checkRefundEligibility(userId)
        break
      case 'process_refund':
        result = await AdminActionsService.processRefund(userId, 'Test refund via AI admin')
        break
      case 'cancel_subscription':
        result = await AdminActionsService.cancelSubscription(userId, 'Test cancellation via AI admin')
        break
      case 'refund_history':
        result = await AdminActionsService.getRefundHistory(userId)
        break
      case 'user_report':
        result = await AdminActionsService.generateUserReport(userId)
        break
      default:
        return res.status(400).json({ error: 'Invalid action' })
    }

    res.json({
      success: true,
      action,
      result
    })
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error testing AI admin actions')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Enhanced conversation endpoint that uses admin actions
router.post('/conversation/enhanced', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { sessionId, message, conversationId } = req.body

    let result
    if (conversationId) {
      // Add message to existing enhanced conversation
      result = await EnhancedConversationService.addEnhancedMessage(conversationId, message)
    } else {
      // Start new enhanced conversation with user context
      const conversation = await EnhancedConversationService.startEnhancedConversation(sessionId, userId, message)
      result = { conversation, aiResponse: null }
    }

    res.json({
      success: true,
      conversation: {
        id: result.conversation.id,
        messages: result.conversation.messages,
        status: result.conversation.status,
        intent: result.conversation.intent,
        personality: result.conversation.personality,
        conversationEnded: result.conversation.conversationState.conversationEnded
      },
      aiResponse: result.aiResponse ? {
        typingDelay: result.aiResponse.typingDelay,
        multiPart: result.aiResponse.multiPart,
        messages: result.aiResponse.messages,
        conversationEnded: result.aiResponse.conversationEnded
      } : null
    })
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error in enhanced conversation')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Enhanced satisfaction tracking endpoints
router.post('/satisfaction/rating', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { conversationId, rating, feedback, category = 'overall' } = req.body
    const userId = req.user!.id

    await SatisfactionTrackingService.submitSatisfactionRating({
      conversationId,
      userId,
      rating,
      feedback,
      category,
      agentType: 'ai'
    })

    res.json({ success: true, message: 'Rating submitted successfully' })
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error submitting satisfaction rating')
    res.status(500).json({ error: 'Failed to submit rating' })
  }
})

router.get('/satisfaction/metrics', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, agentType } = req.query
    
    const metrics = await SatisfactionTrackingService.getSatisfactionMetrics(
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
      agentType as 'ai' | 'human' | undefined
    )

    res.json({ success: true, metrics })
  } catch (error) {
    logger.error({ error }, 'Error getting satisfaction metrics')
    res.status(500).json({ error: 'Failed to get metrics' })
  }
})

// Analytics endpoints
router.get('/analytics/conversations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { startDate, endDate, agentType, issueType, userTier } = req.query
    
    const analytics = await AnalyticsInsightsService.getConversationAnalytics(
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
      {
        agentType: agentType as 'ai' | 'human' | undefined,
        issueType: issueType as string | undefined,
        userTier: userTier as string | undefined
      }
    )

    res.json({ success: true, analytics })
  } catch (error) {
    logger.error({ error }, 'Error getting conversation analytics')
    res.status(500).json({ error: 'Failed to get analytics' })
  }
})

router.get('/analytics/real-time', requireAuth, async (req: AuthRequest, res) => {
  try {
    const metrics = await AnalyticsInsightsService.getRealTimeMetrics()
    res.json({ success: true, metrics })
  } catch (error) {
    logger.error({ error }, 'Error getting real-time metrics')
    res.status(500).json({ error: 'Failed to get real-time metrics' })
  }
})

router.get('/analytics/business-insights', requireAuth, async (req: AuthRequest, res) => {
  try {
    const insights = await AnalyticsInsightsService.getBusinessInsights()
    res.json({ success: true, insights })
  } catch (error) {
    logger.error({ error }, 'Error getting business insights')
    res.status(500).json({ error: 'Failed to get business insights' })
  }
})

// Proactive support endpoints
router.get('/proactive/alerts/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const alerts = await ProactiveSupportService.detectPotentialIssues(userId)
    res.json({ success: true, alerts })
  } catch (error) {
    logger.error({ error, userId: req.params.userId }, 'Error getting proactive alerts')
    res.status(500).json({ error: 'Failed to get proactive alerts' })
  }
})

router.get('/proactive/users-needing-support', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userIds = await ProactiveSupportService.getUsersNeedingProactiveSupport()
    const alerts = await ProactiveSupportService.processProactiveAlerts(userIds)
    
    res.json({ 
      success: true, 
      usersNeedingSupport: userIds.length,
      alerts: Object.fromEntries(alerts)
    })
  } catch (error) {
    logger.error({ error }, 'Error getting users needing proactive support')
    res.status(500).json({ error: 'Failed to get users needing support' })
  }
})

// Escalation system endpoints
router.post('/escalation/evaluate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { conversationId, message, conversationHistory, userTier = 'free' } = req.body
    const userId = req.user!.id

    const decision = await EscalationSystemService.evaluateEscalation(
      conversationId,
      userId,
      message,
      conversationHistory,
      userTier
    )

    res.json({ success: true, decision })
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error evaluating escalation')
    res.status(500).json({ error: 'Failed to evaluate escalation' })
  }
})

router.get('/escalation/agents', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agents = EscalationSystemService.getAvailableAgents()
    res.json({ success: true, agents })
  } catch (error) {
    logger.error({ error }, 'Error getting available agents')
    res.status(500).json({ error: 'Failed to get available agents' })
  }
})

// Multilingual support endpoints
router.post('/translate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { text, targetLanguage, sourceLanguage } = req.body
    
    const translation = await MultilingualSupportService.translateText(
      text,
      targetLanguage,
      sourceLanguage
    )

    res.json({ success: true, translation })
  } catch (error) {
    logger.error({ error }, 'Error translating text')
    res.status(500).json({ error: 'Failed to translate text' })
  }
})

router.post('/detect-language', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { text } = req.body
    const detection = MultilingualSupportService.detectLanguage(text)
    res.json({ success: true, detection })
  } catch (error) {
    logger.error({ error }, 'Error detecting language')
    res.status(500).json({ error: 'Failed to detect language' })
  }
})

router.get('/supported-languages', requireAuth, async (req: AuthRequest, res) => {
  try {
    const languages = MultilingualSupportService.getSupportedLanguages()
    res.json({ success: true, languages })
  } catch (error) {
    logger.error({ error }, 'Error getting supported languages')
    res.status(500).json({ error: 'Failed to get supported languages' })
  }
})

export default router
