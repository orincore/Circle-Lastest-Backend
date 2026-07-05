import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { db } from '../config/db.js'
import { adminRoles, aiConversations, escalationLogs, followUpTasks, profiles, satisfactionRatings } from '../db/schema.js'
// Apply admin authentication to all routes
const router = Router()

// Admin middleware - protect all routes
router.use(requireAuth)

// Admin auth middleware using admin_roles table
const requireAdminAuth = async (req: AuthRequest, res: any, next: any) => {
  try {
    const userId = req.user!.id

    // Check admin_roles table for active admin role
    const [adminRole] = await db.select({
      id: adminRoles.id,
      role: adminRoles.role,
      is_active: adminRoles.isActive,
    })
      .from(adminRoles)
      .where(and(
        eq(adminRoles.userId, userId),
        eq(adminRoles.isActive, true),
        isNull(adminRoles.revokedAt),
      ))

    if (!adminRole) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'Admin privileges required. You must have an active admin role.'
      })
    }

    // Add admin role info to request for downstream use
    req.adminRole = adminRole as { id: string; role: string; is_active: boolean }
    next()
  } catch (error) {
    console.error('Admin auth error:', error)
    res.status(500).json({ error: 'Authentication failed' })
  }
}

// Apply admin auth to all routes
router.use(requireAdminAuth)
import { ConversationService } from '../services/ai/conversation.service.js'
import { AdminActionsService } from '../services/ai/admin-actions.service.js'
import EnhancedConversationService from '../services/ai/enhanced-conversation.service.js'
import SatisfactionTrackingService from '../services/ai/satisfaction-tracking.service.js'
import AnalyticsInsightsService from '../services/ai/analytics-insights.service.js'
import ProactiveSupportService from '../services/ai/proactive-support.service.js'
import EscalationSystemService from '../services/ai/escalation-system.service.js'
import MultilingualSupportService from '../services/ai/multilingual-support.service.js'
import { logger } from '../config/logger.js'

// Admin verification endpoint
router.get('/verify-admin', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Check admin_roles table for active admin role
    const [adminRole] = await db.select({
      id: adminRoles.id,
      role: adminRoles.role,
      granted_at: adminRoles.grantedAt,
      is_active: adminRoles.isActive,
    })
      .from(adminRoles)
      .where(and(
        eq(adminRoles.userId, userId),
        eq(adminRoles.isActive, true),
        isNull(adminRoles.revokedAt),
      ))

    if (!adminRole) {
      return res.status(403).json({
        error: 'Access denied',
        message: 'You do not have admin privileges',
        isAdmin: false
      })
    }

    res.json({ 
      success: true, 
      isAdmin: true,
      user: {
        id: req.user!.id,
        email: req.user!.email,
        role: adminRole.role
      },
      adminRole: {
        id: adminRole.id,
        role: adminRole.role,
        grantedAt: adminRole.granted_at
      }
    })
  } catch (error) {
    logger.error({ error, userId: req.user?.id }, 'Error verifying admin access')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Test endpoint for AI admin capabilities
router.post('/test-admin-actions', async (req: AuthRequest, res) => {
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
router.post('/conversation/enhanced', async (req: AuthRequest, res) => {
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

// Admin dashboard specific endpoints
router.get('/admin/conversations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { page = 1, limit = 20, status, priority } = req.query

    const conditions = []
    if (status) {
      conditions.push(eq(aiConversations.status, status as string))
    }
    if (priority) {
      conditions.push(eq(aiConversations.escalationLevel, priority as string))
    }

    const conversations = await db.select({
      id: aiConversations.id,
      user_id: aiConversations.userId,
      status: aiConversations.status,
      intent: aiConversations.intent,
      satisfaction_rating: aiConversations.satisfactionRating,
      created_at: aiConversations.createdAt,
      updated_at: aiConversations.updatedAt,
      personality: aiConversations.personality,
      sentiment_analysis: aiConversations.sentimentAnalysis,
      escalation_level: aiConversations.escalationLevel,
      detected_language: aiConversations.detectedLanguage,
    })
      .from(aiConversations)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(aiConversations.createdAt))
      .limit(Number(limit))
      .offset((Number(page) - 1) * Number(limit))

    res.json({ success: true, conversations, page: Number(page), limit: Number(limit) })
  } catch (error) {
    logger.error({ error }, 'Error getting admin conversations')
    res.status(500).json({ error: 'Failed to get conversations' })
  }
})

router.get('/admin/conversation/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params

    const [conversation] = await db.select({
      id: aiConversations.id,
      user_id: aiConversations.userId,
      session_id: aiConversations.sessionId,
      messages: aiConversations.messages,
      status: aiConversations.status,
      intent: aiConversations.intent,
      refund_explanation_count: aiConversations.refundExplanationCount,
      estimated_cost: aiConversations.estimatedCost,
      token_count: aiConversations.tokenCount,
      user_context: aiConversations.userContext,
      created_at: aiConversations.createdAt,
      updated_at: aiConversations.updatedAt,
      personality: aiConversations.personality,
      conversation_state: aiConversations.conversationState,
      sentiment_analysis: aiConversations.sentimentAnalysis,
      detected_language: aiConversations.detectedLanguage,
      escalation_level: aiConversations.escalationLevel,
      satisfaction_rating: aiConversations.satisfactionRating,
      proactive_alerts: aiConversations.proactiveAlerts,
    }).from(aiConversations).where(eq(aiConversations.id, id))

    if (!conversation) {
      throw new Error('Conversation not found')
    }

    const conversationSatisfactionRatings = await db.select({
      rating: satisfactionRatings.rating,
      feedback: satisfactionRatings.feedback,
      created_at: satisfactionRatings.createdAt,
    }).from(satisfactionRatings).where(eq(satisfactionRatings.conversationId, id))

    const conversationEscalationLogs = await db.select({
      priority: escalationLogs.priority,
      escalation_reason: escalationLogs.escalationReason,
      assigned_agent: escalationLogs.assignedAgent,
      created_at: escalationLogs.createdAt,
    }).from(escalationLogs).where(eq(escalationLogs.conversationId, id))

    res.json({
      success: true,
      conversation: {
        ...conversation,
        satisfaction_ratings: conversationSatisfactionRatings,
        escalation_logs: conversationEscalationLogs,
      }
    })
  } catch (error) {
    logger.error({ error, conversationId: req.params.id }, 'Error getting conversation details')
    res.status(500).json({ error: 'Failed to get conversation details' })
  }
})

router.get('/admin/escalations', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { page = 1, limit = 20, priority } = req.query

    const rows = await db.select({
      id: escalationLogs.id,
      conversation_id: escalationLogs.conversationId,
      user_id: escalationLogs.userId,
      escalation_reason: escalationLogs.escalationReason,
      priority: escalationLogs.priority,
      sentiment_score: escalationLogs.sentimentScore,
      assigned_agent: escalationLogs.assignedAgent,
      resolved_at: escalationLogs.resolvedAt,
      created_at: escalationLogs.createdAt,
      conv_id: aiConversations.id,
      conv_intent: aiConversations.intent,
      profile_first_name: profiles.firstName,
      profile_last_name: profiles.lastName,
      profile_email: profiles.email,
    })
      .from(escalationLogs)
      .leftJoin(aiConversations, eq(aiConversations.id, escalationLogs.conversationId))
      .leftJoin(profiles, eq(profiles.id, escalationLogs.userId))
      .where(priority ? eq(escalationLogs.priority, priority as string) : undefined)
      .orderBy(desc(escalationLogs.createdAt))
      .limit(Number(limit))
      .offset((Number(page) - 1) * Number(limit))

    const escalations = rows.map(r => ({
      id: r.id,
      conversation_id: r.conversation_id,
      user_id: r.user_id,
      escalation_reason: r.escalation_reason,
      priority: r.priority,
      sentiment_score: r.sentiment_score,
      assigned_agent: r.assigned_agent,
      resolved_at: r.resolved_at,
      created_at: r.created_at,
      ai_conversations: r.conv_id != null ? { id: r.conv_id, intent: r.conv_intent } : null,
      profiles: r.profile_email != null ? { first_name: r.profile_first_name, last_name: r.profile_last_name, email: r.profile_email } : null,
    }))

    res.json({ success: true, escalations, page: Number(page), limit: Number(limit) })
  } catch (error) {
    logger.error({ error }, 'Error getting escalations')
    res.status(500).json({ error: 'Failed to get escalations' })
  }
})

router.get('/admin/survey-responses', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { page = 1, limit = 20, rating } = req.query

    const rows = await db.select({
      id: satisfactionRatings.id,
      conversation_id: satisfactionRatings.conversationId,
      user_id: satisfactionRatings.userId,
      rating: satisfactionRatings.rating,
      feedback: satisfactionRatings.feedback,
      category: satisfactionRatings.category,
      agent_type: satisfactionRatings.agentType,
      agent_id: satisfactionRatings.agentId,
      created_at: satisfactionRatings.createdAt,
      updated_at: satisfactionRatings.updatedAt,
      conv_id: aiConversations.id,
      conv_intent: aiConversations.intent,
      profile_first_name: profiles.firstName,
      profile_last_name: profiles.lastName,
      profile_email: profiles.email,
    })
      .from(satisfactionRatings)
      .leftJoin(aiConversations, eq(aiConversations.id, satisfactionRatings.conversationId))
      .leftJoin(profiles, eq(profiles.id, satisfactionRatings.userId))
      .where(rating ? eq(satisfactionRatings.rating, Number(rating)) : undefined)
      .orderBy(desc(satisfactionRatings.createdAt))
      .limit(Number(limit))
      .offset((Number(page) - 1) * Number(limit))

    const responses = rows.map(r => ({
      id: r.id,
      conversation_id: r.conversation_id,
      user_id: r.user_id,
      rating: r.rating,
      feedback: r.feedback,
      category: r.category,
      agent_type: r.agent_type,
      agent_id: r.agent_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ai_conversations: r.conv_id != null ? { id: r.conv_id, intent: r.conv_intent } : null,
      profiles: r.profile_email != null ? { first_name: r.profile_first_name, last_name: r.profile_last_name, email: r.profile_email } : null,
    }))

    res.json({ success: true, responses, page: Number(page), limit: Number(limit) })
  } catch (error) {
    logger.error({ error }, 'Error getting survey responses')
    res.status(500).json({ error: 'Failed to get survey responses' })
  }
})

router.get('/admin/follow-up-tasks', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { status = 'pending' } = req.query

    const rows = await db.select({
      id: followUpTasks.id,
      conversation_id: followUpTasks.conversationId,
      user_id: followUpTasks.userId,
      urgency: followUpTasks.urgency,
      reason: followUpTasks.reason,
      action_items: followUpTasks.actionItems,
      scheduled_for: followUpTasks.scheduledFor,
      completed_at: followUpTasks.completedAt,
      assigned_to: followUpTasks.assignedTo,
      status: followUpTasks.status,
      created_at: followUpTasks.createdAt,
      updated_at: followUpTasks.updatedAt,
      conv_id: aiConversations.id,
      conv_intent: aiConversations.intent,
      profile_first_name: profiles.firstName,
      profile_last_name: profiles.lastName,
      profile_email: profiles.email,
    })
      .from(followUpTasks)
      .leftJoin(aiConversations, eq(aiConversations.id, followUpTasks.conversationId))
      .leftJoin(profiles, eq(profiles.id, followUpTasks.userId))
      .where(eq(followUpTasks.status, status as string))
      .orderBy(asc(followUpTasks.scheduledFor))

    const tasks = rows.map(r => ({
      id: r.id,
      conversation_id: r.conversation_id,
      user_id: r.user_id,
      urgency: r.urgency,
      reason: r.reason,
      action_items: r.action_items,
      scheduled_for: r.scheduled_for,
      completed_at: r.completed_at,
      assigned_to: r.assigned_to,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      ai_conversations: r.conv_id != null ? { id: r.conv_id, intent: r.conv_intent } : null,
      profiles: r.profile_email != null ? { first_name: r.profile_first_name, last_name: r.profile_last_name, email: r.profile_email } : null,
    }))

    res.json({ success: true, tasks })
  } catch (error) {
    logger.error({ error }, 'Error getting follow-up tasks')
    res.status(500).json({ error: 'Failed to get follow-up tasks' })
  }
})

router.put('/admin/follow-up-task/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const { status, assigned_to, notes } = req.body

    const updates: any = { updatedAt: new Date().toISOString() }

    if (status) updates.status = status
    if (assigned_to) updates.assignedTo = assigned_to
    if (status === 'completed') updates.completedAt = new Date().toISOString()

    const [task] = await db.update(followUpTasks)
      .set(updates)
      .where(eq(followUpTasks.id, id))
      .returning({
        id: followUpTasks.id,
        conversation_id: followUpTasks.conversationId,
        user_id: followUpTasks.userId,
        urgency: followUpTasks.urgency,
        reason: followUpTasks.reason,
        action_items: followUpTasks.actionItems,
        scheduled_for: followUpTasks.scheduledFor,
        completed_at: followUpTasks.completedAt,
        assigned_to: followUpTasks.assignedTo,
        status: followUpTasks.status,
        created_at: followUpTasks.createdAt,
        updated_at: followUpTasks.updatedAt,
      })

    if (!task) {
      throw new Error('Follow-up task not found')
    }

    res.json({ success: true, task })
  } catch (error) {
    logger.error({ error, taskId: req.params.id }, 'Error updating follow-up task')
    res.status(500).json({ error: 'Failed to update task' })
  }
})

router.get('/admin/agent-performance', requireAuth, async (req: AuthRequest, res) => {
  try {
    const agents = await AnalyticsInsightsService.getAgentPerformance()
    res.json({ success: true, agents })
  } catch (error) {
    logger.error({ error }, 'Error getting agent performance')
    res.status(500).json({ error: 'Failed to get agent performance' })
  }
})

router.get('/admin/analytics/report', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { period = 'week' } = req.query
    const report = await AnalyticsInsightsService.generateAnalyticsReport(period as 'week' | 'month' | 'quarter')
    res.json({ success: true, report })
  } catch (error) {
    logger.error({ error }, 'Error generating analytics report')
    res.status(500).json({ error: 'Failed to generate report' })
  }
})

export default router
