import { logger } from '../../config/logger.js'
import type { AIResponse } from './together-ai.service.js'

export interface RefundEligibility {
  eligible: boolean
  daysFromStart: number
  subscriptionStartDate: Date
  reason: string
}

export class RefundPolicyService {
  private static readonly REFUND_WINDOW_DAYS = 7
  private static readonly MAX_EXPLANATIONS = 3

  // Handle refund request with business logic
  static async handleRefundRequest(
    userMessage: string,
    userContext: any,
    explanationCount: number
  ): Promise<AIResponse | null> {
    try {
      if (!userContext?.latestSubscription) {
        return {
          message: `I understand you're asking about a refund. To help you better, I'll need to check your subscription details. 

Our refund policy allows refunds within 7 days of your subscription start date. If you don't have an active subscription or need help with your account, please contact our support team at contact@orincore.com.

Is there anything else I can help you with regarding your Circle account?`,
          confidence: 0.9,
          intent: 'refund',
          requiresEscalation: false,
          conversationEnded: false
        }
      }

      const eligibility = this.checkRefundEligibility(userContext.latestSubscription)

      if (eligibility.eligible) {
        return this.generateEligibleRefundResponse(userContext.latestSubscription)
      } else {
        return this.generateIneligibleRefundResponse(eligibility, explanationCount)
      }
    } catch (error) {
      logger.error({ error, userMessage, userContext }, 'Error handling refund request')
      return null
    }
  }

  // Check if user is eligible for refund
  private static checkRefundEligibility(subscription: any): RefundEligibility {
    const startDate = new Date(subscription.started_at)
    const currentDate = new Date()
    const daysDiff = Math.floor((currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))

    const eligible = daysDiff <= this.REFUND_WINDOW_DAYS

    return {
      eligible,
      daysFromStart: daysDiff,
      subscriptionStartDate: startDate,
      reason: eligible 
        ? 'Within refund window' 
        : `${daysDiff} days have passed since subscription start (limit: ${this.REFUND_WINDOW_DAYS} days)`
    }
  }

  // Generate response for eligible refund
  private static generateEligibleRefundResponse(subscription: any): AIResponse {
    const planName = this.formatPlanName(subscription.plan_type)
    const amount = subscription.price_paid || 9.99
    const currency = subscription.currency || 'USD'

    return {
      message: `Good news! Your ${planName} subscription is eligible for a refund since it's within our 7-day refund window.

Here's what I can help you with:

**Your Subscription:**
• Plan: ${planName}
• Amount: ${this.formatCurrency(amount, currency)}
• Started: ${this.formatDate(subscription.started_at)}

**Refund Process:**
1. I can guide you through requesting a refund
2. Refunds are typically processed within 3-5 business days
3. The refund will go back to your original payment method

Would you like me to help you start the refund process, or do you have any questions about your subscription first?`,
      confidence: 0.95,
      intent: 'refund',
      requiresEscalation: false,
      conversationEnded: false
    }
  }

  // Generate response for ineligible refund with empathy and policy explanation
  private static generateIneligibleRefundResponse(
    eligibility: RefundEligibility,
    explanationCount: number
  ): AIResponse {
    const daysAgo = eligibility.daysFromStart
    const subscriptionDate = this.formatDate(eligibility.subscriptionStartDate)

    // First explanation - empathetic and detailed
    if (explanationCount === 0) {
      return {
        message: `I completely understand your concern about wanting a refund, and I truly wish I could help you with this.

Unfortunately, your subscription started ${daysAgo} days ago (on ${subscriptionDate}), which is outside our 7-day refund window. Our refund policy allows refunds only within 7 days of the subscription start date.

**Why we have this policy:**
• It helps us maintain fair and affordable pricing for all users
• It covers our operational costs and platform maintenance
• It ensures we can continue improving Circle for everyone

I know this isn't the answer you were hoping for. Is there anything else I can help you with regarding your Circle experience? Perhaps I can help with account settings, features, or other questions?`,
        confidence: 0.9,
        intent: 'refund',
        requiresEscalation: false,
        conversationEnded: false
      }
    }

    // Second explanation - shorter but still empathetic
    if (explanationCount === 1) {
      return {
        message: `I really understand your frustration, and I wish the circumstances were different. 

As I mentioned, our 7-day refund policy is firm - your subscription started ${daysAgo} days ago, which is beyond this window. This policy is consistently applied to all users to maintain fairness and operational sustainability.

While I can't process a refund, I'm here to help you get the most value from your Circle subscription. Would you like me to explain any features or help with your account in other ways?

If you feel you have exceptional circumstances, our support team at contact@orincore.com can review your specific situation.`,
        confidence: 0.85,
        intent: 'refund',
        requiresEscalation: false,
        conversationEnded: false
      }
    }

    // Third explanation - final empathetic denial with escalation
    if (explanationCount === 2) {
      return {
        message: `I truly empathize with your situation and understand how disappointing this must be.

I've explained our 7-day refund policy twice now, and I want to be completely transparent: I cannot make exceptions to this policy. Your subscription started ${daysAgo} days ago, which is outside our refund window.

**Final options for you:**
• Contact our support team at contact@orincore.com - they can review exceptional circumstances
• I can help you make the most of your current subscription
• I can assist with canceling future billing if you don't want to continue

I'm sorry I couldn't provide the outcome you were hoping for. How would you like to proceed?`,
        confidence: 0.8,
        intent: 'refund',
        requiresEscalation: true,
        conversationEnded: false
      }
    }

    // After 3 explanations - polite final denial
    return {
      message: `I understand you're disappointed, and I've done my best to explain our refund policy clearly.

After our discussion, I must respectfully maintain that refunds are only available within 7 days of subscription start. Your subscription began ${daysAgo} days ago, which is outside this window.

For any further review of your situation, please contact our support team directly at contact@orincore.com. They have access to additional tools and can provide a comprehensive review of your account.

Thank you for understanding, and I hope you'll find value in your Circle experience moving forward.`,
      confidence: 0.75,
      intent: 'refund',
      requiresEscalation: true,
      conversationEnded: true
    }
  }

  // Helper method to format plan names
  private static formatPlanName(planType: string): string {
    switch (planType) {
      case 'premium_plus':
        return 'Premium Plus'
      case 'premium':
        return 'Premium'
      case 'free':
        return 'Free'
      default:
        return planType.charAt(0).toUpperCase() + planType.slice(1)
    }
  }

  // Helper method to format currency
  private static formatCurrency(amount: number, currency: string = 'USD'): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency
    }).format(amount)
  }

  // Helper method to format dates
  private static formatDate(dateString: string | Date): string {
    const date = typeof dateString === 'string' ? new Date(dateString) : dateString
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  // Check if message indicates user wants to escalate
  static isEscalationRequest(message: string): boolean {
    const escalationKeywords = [
      'speak to human',
      'talk to person',
      'human agent',
      'real person',
      'manager',
      'supervisor',
      'escalate',
      'not satisfied',
      'this is ridiculous',
      'terrible service'
    ]

    const lowerMessage = message.toLowerCase()
    return escalationKeywords.some(keyword => lowerMessage.includes(keyword))
  }

  // Generate escalation response
  static generateEscalationResponse(reason: string = 'general inquiry'): AIResponse {
    return {
      message: `I understand you'd like to speak with someone who can provide additional assistance.

While I don't have access to live chat agents, I can help you connect with our support team via email. Our team at contact@orincore.com typically responds within 24 hours and can provide personalized assistance for your situation.

Would you like me to help you draft an email with your specific concerns? I can summarize our conversation to help them understand your situation better.`,
      confidence: 0.9,
      intent: 'escalation',
      requiresEscalation: true,
      conversationEnded: false
    }
  }

  // Generate conversation summary for escalation
  static generateConversationSummary(messages: any[]): string {
    const userMessages = messages.filter(m => m.role === 'user')
    const mainIssue = userMessages[0]?.content || 'General inquiry'
    
    const summary = `
Customer Support Request Summary:

Main Issue: ${mainIssue}

Conversation Points:
${userMessages.map((msg, index) => `${index + 1}. ${msg.content}`).join('\n')}

AI Assistant attempted to resolve the issue but customer requested human assistance.
Please review and provide personalized support.
    `.trim()

    return summary
  }

  // Validate refund eligibility for admin use
  static validateRefundEligibility(subscriptionStartDate: string): {
    eligible: boolean
    daysRemaining: number
    message: string
  } {
    const startDate = new Date(subscriptionStartDate)
    const currentDate = new Date()
    const daysPassed = Math.floor((currentDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    const daysRemaining = this.REFUND_WINDOW_DAYS - daysPassed

    const eligible = daysPassed <= this.REFUND_WINDOW_DAYS

    return {
      eligible,
      daysRemaining: Math.max(0, daysRemaining),
      message: eligible 
        ? `Eligible for refund (${daysRemaining} days remaining)`
        : `Not eligible - ${daysPassed} days have passed (limit: ${this.REFUND_WINDOW_DAYS} days)`
    }
  }
}
