import { and, eq, gte, lte } from 'drizzle-orm'
import { db } from '../../config/db.js'
import { aiConversations, feedbackAnalysis, followUpTasks, satisfactionRatings, satisfactionSurveys, surveyResponses } from '../../db/schema.js'
import { logger } from '../../config/logger.js'

export interface SatisfactionRating {
  conversationId: string
  userId: string
  rating: 1 | 2 | 3 | 4 | 5
  feedback?: string
  category: 'resolution' | 'speed' | 'politeness' | 'knowledge' | 'overall'
  timestamp: Date
  agentType: 'ai' | 'human'
  agentId?: string
}

export interface SatisfactionSurvey {
  id: string
  conversationId: string
  questions: SurveyQuestion[]
  responses: SurveyResponse[]
  overallScore: number
  completedAt?: Date
  followUpRequired: boolean
}

export interface SurveyQuestion {
  id: string
  type: 'rating' | 'multiple_choice' | 'text' | 'yes_no'
  question: string
  options?: string[]
  required: boolean
  category: string
}

export interface SurveyResponse {
  questionId: string
  answer: string | number
  timestamp: Date
}

export interface SatisfactionMetrics {
  averageRating: number
  totalResponses: number
  ratingDistribution: Record<number, number>
  categoryScores: Record<string, number>
  trendData: { date: string; score: number }[]
  commonIssues: { issue: string; count: number; impact: number }[]
  improvementAreas: string[]
}

export interface FeedbackAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral'
  themes: string[]
  actionItems: string[]
  urgency: 'low' | 'medium' | 'high'
  followUpRequired: boolean
}

export class SatisfactionTrackingService {
  // Standard satisfaction survey questions
  private static standardQuestions: SurveyQuestion[] = [
    {
      id: 'overall_satisfaction',
      type: 'rating',
      question: 'How satisfied are you with the support you received today?',
      required: true,
      category: 'overall'
    },
    {
      id: 'resolution_quality',
      type: 'rating',
      question: 'How well did we resolve your issue?',
      required: true,
      category: 'resolution'
    },
    {
      id: 'response_speed',
      type: 'rating',
      question: 'How satisfied are you with our response time?',
      required: true,
      category: 'speed'
    },
    {
      id: 'agent_politeness',
      type: 'rating',
      question: 'How would you rate the politeness and professionalism of our support?',
      required: true,
      category: 'politeness'
    },
    {
      id: 'knowledge_helpfulness',
      type: 'rating',
      question: 'How knowledgeable and helpful was our support team?',
      required: true,
      category: 'knowledge'
    },
    {
      id: 'recommendation',
      type: 'yes_no',
      question: 'Would you recommend Circle to a friend?',
      required: false,
      category: 'loyalty'
    },
    {
      id: 'improvement_feedback',
      type: 'text',
      question: 'What could we do better? (Optional)',
      required: false,
      category: 'improvement'
    },
    {
      id: 'additional_comments',
      type: 'text',
      question: 'Any additional comments or suggestions?',
      required: false,
      category: 'general'
    }
  ]

  // Create satisfaction survey for conversation
  static async createSatisfactionSurvey(conversationId: string): Promise<SatisfactionSurvey> {
    try {
      const survey: SatisfactionSurvey = {
        id: `survey_${conversationId}_${Date.now()}`,
        conversationId,
        questions: this.standardQuestions,
        responses: [],
        overallScore: 0,
        followUpRequired: false
      }

      // Save survey to database
      await db.insert(satisfactionSurveys).values({
        id: survey.id,
        conversationId: conversationId,
        questions: JSON.stringify(survey.questions),
        createdAt: new Date().toISOString(),
      })

      return survey
    } catch (error) {
      logger.error({ error, conversationId }, 'Error creating satisfaction survey')
      throw error
    }
  }

  // Submit satisfaction rating
  static async submitSatisfactionRating(rating: Omit<SatisfactionRating, 'timestamp'>): Promise<void> {
    try {
      const ratingWithTimestamp: SatisfactionRating = {
        ...rating,
        timestamp: new Date()
      }

      // Save rating to database
      await db.insert(satisfactionRatings).values({
        conversationId: rating.conversationId,
        userId: rating.userId,
        rating: rating.rating,
        feedback: rating.feedback,
        category: rating.category,
        agentType: rating.agentType,
        agentId: rating.agentId,
        createdAt: ratingWithTimestamp.timestamp.toISOString(),
      })

      // Analyze feedback if provided
      if (rating.feedback) {
        const analysis = await this.analyzeFeedback(rating.feedback, rating.rating)
        
        // Log analysis results
        await this.logFeedbackAnalysis(rating.conversationId, analysis)
        
        // Check if follow-up is needed
        if (analysis.followUpRequired) {
          await this.scheduleFollowUp(rating.conversationId, rating.userId, analysis)
        }
      }

      // Update conversation with satisfaction data
      await this.updateConversationSatisfaction(rating.conversationId, rating.rating)

    } catch (error) {
      logger.error({ error, rating }, 'Error submitting satisfaction rating')
      throw error
    }
  }

  // Submit survey response
  static async submitSurveyResponse(
    surveyId: string,
    questionId: string,
    answer: string | number
  ): Promise<void> {
    try {
      const response: SurveyResponse = {
        questionId,
        answer,
        timestamp: new Date()
      }

      // Save response to database
      await db.insert(surveyResponses).values({
        surveyId: surveyId,
        questionId: questionId,
        answer: typeof answer === 'string' ? answer : answer.toString(),
        createdAt: response.timestamp.toISOString(),
      })

      // Check if survey is complete and calculate overall score
      await this.checkSurveyCompletion(surveyId)

    } catch (error) {
      logger.error({ error, surveyId, questionId }, 'Error submitting survey response')
      throw error
    }
  }

  // Analyze feedback text
  private static async analyzeFeedback(feedback: string, rating: number): Promise<FeedbackAnalysis> {
    const lowerFeedback = feedback.toLowerCase()
    
    // Determine sentiment
    let sentiment: FeedbackAnalysis['sentiment'] = 'neutral'
    if (rating >= 4) {
      sentiment = 'positive'
    } else if (rating <= 2) {
      sentiment = 'negative'
    }

    // Extract themes
    const themes = this.extractThemes(lowerFeedback)
    
    // Generate action items
    const actionItems = this.generateActionItems(lowerFeedback, themes, rating)
    
    // Determine urgency
    const urgency = this.determineUrgency(lowerFeedback, rating)
    
    // Check if follow-up is required
    const followUpRequired = rating <= 2 || this.requiresFollowUp(lowerFeedback)

    return {
      sentiment,
      themes,
      actionItems,
      urgency,
      followUpRequired
    }
  }

  // Extract themes from feedback
  private static extractThemes(feedback: string): string[] {
    const themes: string[] = []
    
    const themeKeywords = {
      'response_time': ['slow', 'fast', 'quick', 'time', 'wait', 'delay'],
      'resolution': ['solved', 'fixed', 'resolved', 'problem', 'issue', 'help'],
      'politeness': ['rude', 'polite', 'friendly', 'professional', 'attitude'],
      'knowledge': ['knowledgeable', 'helpful', 'understand', 'explain', 'clear'],
      'technical': ['bug', 'error', 'technical', 'feature', 'app', 'website'],
      'billing': ['payment', 'billing', 'charge', 'refund', 'money', 'cost'],
      'matching': ['match', 'profile', 'algorithm', 'suggestions', 'compatibility']
    }

    Object.entries(themeKeywords).forEach(([theme, keywords]) => {
      if (keywords.some(keyword => feedback.includes(keyword))) {
        themes.push(theme)
      }
    })

    return themes
  }

  // Generate action items based on feedback
  private static generateActionItems(feedback: string, themes: string[], rating: number): string[] {
    const actionItems: string[] = []

    if (rating <= 2) {
      actionItems.push('Schedule follow-up call with customer')
      actionItems.push('Review conversation for improvement opportunities')
    }

    if (themes.includes('response_time') && feedback.includes('slow')) {
      actionItems.push('Investigate response time optimization')
    }

    if (themes.includes('technical') && rating <= 3) {
      actionItems.push('Escalate technical issue to development team')
    }

    if (themes.includes('billing') && rating <= 3) {
      actionItems.push('Review billing process and customer communication')
    }

    if (feedback.includes('confusing') || feedback.includes('unclear')) {
      actionItems.push('Improve clarity in customer communications')
    }

    return actionItems
  }

  // Determine urgency level
  private static determineUrgency(feedback: string, rating: number): FeedbackAnalysis['urgency'] {
    if (rating === 1 || feedback.includes('terrible') || feedback.includes('awful')) {
      return 'high'
    }

    if (rating === 2 || feedback.includes('disappointed') || feedback.includes('frustrated')) {
      return 'medium'
    }

    return 'low'
  }

  // Check if follow-up is required
  private static requiresFollowUp(feedback: string): boolean {
    const followUpIndicators = [
      'still have', 'not resolved', 'still problem', 'need more help',
      'call me', 'contact me', 'follow up', 'unresolved'
    ]

    return followUpIndicators.some(indicator => feedback.includes(indicator))
  }

  // Get satisfaction metrics
  static async getSatisfactionMetrics(
    startDate?: Date,
    endDate?: Date,
    agentType?: 'ai' | 'human'
  ): Promise<SatisfactionMetrics> {
    try {
      const conditions = []
      if (startDate) {
        conditions.push(gte(satisfactionRatings.createdAt, startDate.toISOString()))
      }
      if (endDate) {
        conditions.push(lte(satisfactionRatings.createdAt, endDate.toISOString()))
      }
      if (agentType) {
        conditions.push(eq(satisfactionRatings.agentType, agentType))
      }

      const ratings = await db.select({
        rating: satisfactionRatings.rating,
        category: satisfactionRatings.category,
        feedback: satisfactionRatings.feedback,
        created_at: satisfactionRatings.createdAt,
        agent_type: satisfactionRatings.agentType,
      })
        .from(satisfactionRatings)
        .where(conditions.length > 0 ? and(...conditions) : undefined)

      if (!ratings || ratings.length === 0) {
        return {
          averageRating: 0,
          totalResponses: 0,
          ratingDistribution: {},
          categoryScores: {},
          trendData: [],
          commonIssues: [],
          improvementAreas: []
        }
      }

      // Calculate metrics
      const totalResponses = ratings.length
      const averageRating = ratings.reduce((sum, r) => sum + r.rating, 0) / totalResponses

      // Rating distribution
      const ratingDistribution: Record<number, number> = {}
      for (let i = 1; i <= 5; i++) {
        ratingDistribution[i] = ratings.filter(r => r.rating === i).length
      }

      // Category scores
      const categoryScores: Record<string, number> = {}
      const categories = [...new Set(ratings.map(r => r.category))]
      
      categories.forEach(category => {
        const categoryRatings = ratings.filter(r => r.category === category)
        if (categoryRatings.length > 0) {
          categoryScores[category] = categoryRatings.reduce((sum, r) => sum + r.rating, 0) / categoryRatings.length
        }
      })

      // Trend data (last 30 days)
      const trendData = await this.calculateTrendData(ratings)

      // Common issues from feedback
      const commonIssues = await this.extractCommonIssues(ratings)

      // Improvement areas
      const improvementAreas = this.identifyImprovementAreas(categoryScores, commonIssues)

      return {
        averageRating,
        totalResponses,
        ratingDistribution,
        categoryScores,
        trendData,
        commonIssues,
        improvementAreas
      }
    } catch (error) {
      logger.error({ error }, 'Error getting satisfaction metrics')
      throw error
    }
  }

  // Calculate trend data
  private static async calculateTrendData(ratings: any[]): Promise<{ date: string; score: number }[]> {
    const last30Days = Array.from({ length: 30 }, (_, i) => {
      const date = new Date()
      date.setDate(date.getDate() - i)
      return date.toISOString().split('T')[0]
    }).reverse()

    return last30Days.map(date => {
      const dayRatings = ratings.filter(r => r.created_at.startsWith(date))
      const score = dayRatings.length > 0 
        ? dayRatings.reduce((sum, r) => sum + r.rating, 0) / dayRatings.length 
        : 0

      return { date, score }
    })
  }

  // Extract common issues from feedback
  private static async extractCommonIssues(ratings: any[]): Promise<{ issue: string; count: number; impact: number }[]> {
    const feedbackRatings = ratings.filter(r => r.feedback && r.feedback.trim().length > 0)
    const issues: Record<string, { count: number; totalImpact: number }> = {}

    const issueKeywords = {
      'Slow response time': ['slow', 'delay', 'wait', 'time'],
      'Technical problems': ['bug', 'error', 'crash', 'broken', 'not working'],
      'Billing issues': ['payment', 'billing', 'charge', 'refund'],
      'Poor communication': ['rude', 'unclear', 'confusing', 'unprofessional'],
      'Unresolved problems': ['not solved', 'still problem', 'not fixed', 'unresolved']
    }

    feedbackRatings.forEach(rating => {
      const feedback = rating.feedback.toLowerCase()
      const impact = 6 - rating.rating // Higher impact for lower ratings

      Object.entries(issueKeywords).forEach(([issue, keywords]) => {
        if (keywords.some(keyword => feedback.includes(keyword))) {
          if (!issues[issue]) {
            issues[issue] = { count: 0, totalImpact: 0 }
          }
          issues[issue].count++
          issues[issue].totalImpact += impact
        }
      })
    })

    return Object.entries(issues)
      .map(([issue, data]) => ({
        issue,
        count: data.count,
        impact: data.totalImpact / data.count
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
  }

  // Identify improvement areas
  private static identifyImprovementAreas(
    categoryScores: Record<string, number>,
    commonIssues: { issue: string; count: number; impact: number }[]
  ): string[] {
    const areas: string[] = []

    // Categories with low scores
    Object.entries(categoryScores).forEach(([category, score]) => {
      if (score < 3.5) {
        areas.push(`Improve ${category} performance`)
      }
    })

    // High-impact common issues
    commonIssues.forEach(issue => {
      if (issue.impact > 3) {
        areas.push(`Address: ${issue.issue}`)
      }
    })

    return areas.slice(0, 5) // Top 5 improvement areas
  }

  // Helper methods
  private static async checkSurveyCompletion(surveyId: string): Promise<void> {
    try {
      const responses = await db.select({
        question_id: surveyResponses.questionId,
        answer: surveyResponses.answer,
      }).from(surveyResponses).where(eq(surveyResponses.surveyId, surveyId))

      const [survey] = await db.select({
        questions: satisfactionSurveys.questions,
      }).from(satisfactionSurveys).where(eq(satisfactionSurveys.id, surveyId))

      if (survey && responses) {
        const questions = JSON.parse(survey.questions as any)
        const requiredQuestions = questions.filter((q: SurveyQuestion) => q.required)
        const answeredRequired = responses.filter(r => 
          requiredQuestions.some((q: SurveyQuestion) => q.id === r.question_id)
        )

        if (answeredRequired.length === requiredQuestions.length) {
          // Calculate overall score
          const ratingResponses = responses.filter(r => 
            questions.find((q: SurveyQuestion) => q.id === r.question_id)?.type === 'rating'
          )
          
          const overallScore = ratingResponses.length > 0
            ? ratingResponses.reduce((sum, r) => sum + parseInt(r.answer), 0) / ratingResponses.length
            : 0

          // Mark survey as complete
          await db.update(satisfactionSurveys)
            .set({
              overallScore: overallScore as any,
              completedAt: new Date().toISOString(),
            })
            .where(eq(satisfactionSurveys.id, surveyId))
        }
      }
    } catch (error) {
      logger.error({ error, surveyId }, 'Error checking survey completion')
    }
  }

  private static async logFeedbackAnalysis(conversationId: string, analysis: FeedbackAnalysis): Promise<void> {
    try {
      await db.insert(feedbackAnalysis).values({
        conversationId: conversationId,
        sentiment: analysis.sentiment,
        themes: JSON.stringify(analysis.themes),
        actionItems: JSON.stringify(analysis.actionItems),
        urgency: analysis.urgency,
        followUpRequired: analysis.followUpRequired,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      logger.error({ error, conversationId }, 'Error logging feedback analysis')
    }
  }

  private static async scheduleFollowUp(
    conversationId: string,
    userId: string,
    analysis: FeedbackAnalysis
  ): Promise<void> {
    try {
      await db.insert(followUpTasks).values({
        conversationId: conversationId,
        userId: userId,
        urgency: analysis.urgency,
        reason: 'Low satisfaction rating',
        actionItems: JSON.stringify(analysis.actionItems),
        scheduledFor: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      logger.error({ error, conversationId }, 'Error scheduling follow-up')
    }
  }

  private static async updateConversationSatisfaction(conversationId: string, rating: number): Promise<void> {
    try {
      await db.update(aiConversations)
        .set({
          satisfactionRating: rating,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(aiConversations.id, conversationId))
    } catch (error) {
      logger.error({ error, conversationId }, 'Error updating conversation satisfaction')
    }
  }

  // Generate satisfaction report
  static async generateSatisfactionReport(period: 'week' | 'month' | 'quarter'): Promise<{
    summary: SatisfactionMetrics
    insights: string[]
    recommendations: string[]
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

    const metrics = await this.getSatisfactionMetrics(startDate, endDate)
    
    const insights = [
      `Average satisfaction rating: ${metrics.averageRating.toFixed(2)}/5`,
      `Total responses: ${metrics.totalResponses}`,
      `${Math.round((metrics.ratingDistribution[4] + metrics.ratingDistribution[5]) / metrics.totalResponses * 100)}% positive ratings`,
      `Top improvement area: ${metrics.improvementAreas[0] || 'None identified'}`
    ]

    const recommendations = metrics.improvementAreas.slice(0, 3)

    return {
      summary: metrics,
      insights,
      recommendations
    }
  }
}

export default SatisfactionTrackingService
