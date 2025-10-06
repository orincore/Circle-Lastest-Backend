import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { ConversationService } from '../services/ai/conversation.service.js'
import { AdminActionsService } from '../services/ai/admin-actions.service.js'
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

    let conversation
    if (conversationId) {
      // Add message to existing conversation
      const result = await ConversationService.addMessage(conversationId, message)
      conversation = result.conversation
    } else {
      // Start new conversation with user context
      conversation = await ConversationService.startConversation(sessionId, userId, message)
    }

    res.json({
      success: true,
      conversation: {
        id: conversation.id,
        messages: conversation.messages,
        status: conversation.status,
        intent: conversation.intent
      }
    })
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error in enhanced conversation')
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
