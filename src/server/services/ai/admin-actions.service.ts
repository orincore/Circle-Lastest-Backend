import { eq, desc, sql } from 'drizzle-orm'
import { db } from '../../config/db.js'
import { userSubscriptions, refunds, profiles } from '../../db/schema.js'
import { logger } from '../../config/logger.js'
import type { AIResponse } from './together-ai.service.js'

export interface AdminActionResult {
  success: boolean
  message: string
  data?: any
  actionTaken?: string
}

export class AdminActionsService {
  // Check user's subscription status
  static async checkSubscriptionStatus(userId: string): Promise<AdminActionResult> {
    try {
      let subscriptionRows
      try {
        subscriptionRows = await db.select({
          id: userSubscriptions.id,
          user_id: userSubscriptions.userId,
          plan_type: userSubscriptions.planId,
          status: userSubscriptions.status,
          started_at: userSubscriptions.startedAt,
          expires_at: userSubscriptions.expiresAt,
          payment_provider: userSubscriptions.source,
          external_subscription_id: sql<string | null>`coalesce(${userSubscriptions.appleOriginalTransactionId}, ${userSubscriptions.googlePurchaseToken}, ${userSubscriptions.razorpaySubscriptionId})`,
          price_paid: userSubscriptions.amount,
          currency: userSubscriptions.currency,
          auto_renew: userSubscriptions.autoRenew,
          cancelled_at: userSubscriptions.cancelledAt,
          created_at: userSubscriptions.createdAt,
          updated_at: userSubscriptions.updatedAt,
        })
          .from(userSubscriptions)
          .where(eq(userSubscriptions.userId, userId))
          .orderBy(desc(userSubscriptions.startedAt))
      } catch (error) {
        return {
          success: false,
          message: 'Failed to retrieve subscription information'
        }
      }

      const activeSubscription = subscriptionRows?.find(sub => sub.status === 'active')

      if (!activeSubscription) {
        return {
          success: true,
          message: 'No active subscription found. You currently have a free account.',
          data: {
            hasActiveSubscription: false,
            subscriptions: subscriptionRows || []
          }
        }
      }

      const startDate = new Date(activeSubscription.started_at as string)
      const daysSinceStart = Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24))

      return {
        success: true,
        message: `Active subscription found: ${activeSubscription.plan_type} plan started ${daysSinceStart} days ago.`,
        data: {
          hasActiveSubscription: true,
          activeSubscription,
          daysSinceStart,
          subscriptions: subscriptionRows || []
        }
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error checking subscription status')
      return {
        success: false,
        message: 'Error retrieving subscription information'
      }
    }
  }

  // Check refund eligibility
  static async checkRefundEligibility(userId: string): Promise<AdminActionResult> {
    try {
      const subscriptionResult = await this.checkSubscriptionStatus(userId)

      if (!subscriptionResult.success || !subscriptionResult.data?.hasActiveSubscription) {
        return {
          success: false,
          message: 'No active subscription found. Refunds are only available for active subscriptions.'
        }
      }

      const { activeSubscription, daysSinceStart } = subscriptionResult.data
      const isEligible = daysSinceStart <= 7

      // Determine refund amount - use price_paid or default based on plan type
      let refundAmount = activeSubscription.price_paid
      if (!refundAmount || refundAmount === 0) {
        // Fallback to default plan prices if price_paid is not set
        refundAmount = activeSubscription.plan_type === 'yearly' ? 1769 : 176
        logger.warn({ userId, subscriptionId: activeSubscription.id }, 'price_paid is null, using default plan price')
      }

      return {
        success: true,
        message: isEligible
          ? `✅ Refund eligible! Your subscription started ${daysSinceStart} days ago (within 7-day window).`
          : `❌ Refund not eligible. Your subscription started ${daysSinceStart} days ago (outside 7-day window).`,
        data: {
          eligible: isEligible,
          daysSinceStart,
          subscription: activeSubscription,
          refundAmount: refundAmount,
          currency: activeSubscription.currency || 'INR'
        }
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error checking refund eligibility')
      return {
        success: false,
        message: 'Error checking refund eligibility'
      }
    }
  }

  // Process refund automatically
  static async processRefund(userId: string, reason: string = 'AI Assistant Processed'): Promise<AdminActionResult> {
    try {
      // Check eligibility first
      const eligibilityResult = await this.checkRefundEligibility(userId)

      if (!eligibilityResult.success || !eligibilityResult.data?.eligible) {
        return {
          success: false,
          message: eligibilityResult.message
        }
      }

      const { subscription, refundAmount, currency } = eligibilityResult.data

      // Create refund record
      let refund: any
      try {
        const nowIso = new Date().toISOString()
        const [inserted] = await db.insert(refunds).values({
          userId: userId,
          subscriptionId: subscription.id,
          amount: refundAmount,
          currency: currency,
          reason: reason,
          status: 'approved',
          paymentProvider: subscription.payment_provider,
          requestedAt: nowIso,
          processedAt: nowIso,
          // processedBy removed - field expects UUID, not string
        }).returning()
        refund = inserted
      } catch (refundError) {
        logger.error({ error: refundError, userId }, 'Error creating refund record')
        return {
          success: false,
          message: 'Failed to process refund'
        }
      }

      // Cancel the subscription
      try {
        await db.update(userSubscriptions)
          .set({
            status: 'cancelled',
            cancelledAt: new Date().toISOString()
          })
          .where(eq(userSubscriptions.id, subscription.id))
      } catch (cancelError) {
        logger.error({ error: cancelError, userId, subscriptionId: subscription.id }, 'Error cancelling subscription')
      }

      // Send refund notification email (if email service is available)
      try {
        const [profile] = await db.select({
          email: profiles.email,
          username: profiles.username,
        }).from(profiles).where(eq(profiles.id, userId))

        if (profile?.email) {
          // Import email service dynamically
          const { default: EmailService } = await import('../../services/emailService.js')

          await EmailService.sendRefundRequestConfirmation(
            profile.email,
            profile.username || 'User',
            subscription.plan_type,
            refundAmount,
            currency,
            refund.id
          )
        }
      } catch (emailError) {
        logger.warn({ error: emailError, userId }, 'Failed to send refund confirmation email')
      }

      return {
        success: true,
        message: `✅ Refund processed successfully! ${refundAmount} ${currency} will be refunded to your original payment method within 3-5 business days.`,
        data: {
          refund,
          amount: refundAmount,
          currency,
          refundId: refund.id
        },
        actionTaken: 'refund_processed'
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error processing refund')
      return {
        success: false,
        message: 'Error processing refund'
      }
    }
  }

  // Cancel subscription without refund
  static async cancelSubscription(userId: string, reason: string = 'User requested cancellation'): Promise<AdminActionResult> {
    try {
      const subscriptionResult = await this.checkSubscriptionStatus(userId)

      if (!subscriptionResult.success || !subscriptionResult.data?.hasActiveSubscription) {
        return {
          success: false,
          message: 'No active subscription found to cancel.'
        }
      }

      const { activeSubscription } = subscriptionResult.data

      try {
        await db.update(userSubscriptions)
          .set({
            status: 'cancelled',
            cancelledAt: new Date().toISOString()
          })
          .where(eq(userSubscriptions.id, activeSubscription.id))
      } catch (error) {
        logger.error({ error, userId, subscriptionId: activeSubscription.id }, 'Error cancelling subscription')
        return {
          success: false,
          message: 'Failed to cancel subscription'
        }
      }

      // Send cancellation confirmation email
      try {
        const [profile] = await db.select({
          email: profiles.email,
          username: profiles.username,
        }).from(profiles).where(eq(profiles.id, userId))

        if (profile?.email) {
          // Import email service dynamically
          const { default: EmailService } = await import('../../services/emailService.js')

          await EmailService.sendSubscriptionCancellationEmail(
            profile.email,
            profile.username || 'User',
            activeSubscription.plan_type,
            new Date().toISOString()
          )
        }
      } catch (emailError) {
        logger.warn({ error: emailError, userId }, 'Failed to send cancellation confirmation email')
      }

      return {
        success: true,
        message: `✅ Subscription cancelled successfully. Your ${activeSubscription.plan_type} plan has been cancelled and will not renew.`,
        data: {
          cancelledSubscription: activeSubscription
        },
        actionTaken: 'subscription_cancelled'
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error cancelling subscription')
      return {
        success: false,
        message: 'Error cancelling subscription'
      }
    }
  }

  // Get user's refund history
  static async getRefundHistory(userId: string): Promise<AdminActionResult> {
    try {
      let refundRows
      try {
        refundRows = await db.select({
          id: refunds.id,
          amount: refunds.amount,
          currency: refunds.currency,
          status: refunds.status,
          requested_at: refunds.requestedAt,
          processed_at: refunds.processedAt,
          reason: refunds.reason,
        })
          .from(refunds)
          .where(eq(refunds.userId, userId))
          .orderBy(desc(refunds.requestedAt))
      } catch (error) {
        return {
          success: false,
          message: 'Failed to retrieve refund history'
        }
      }

      if (!refundRows || refundRows.length === 0) {
        return {
          success: true,
          message: 'No refund history found.',
          data: { refunds: [] }
        }
      }

      const refundSummary = refundRows.map(refund => ({
        id: refund.id,
        amount: refund.amount,
        currency: refund.currency,
        status: refund.status,
        requestedAt: refund.requested_at,
        processedAt: refund.processed_at,
        reason: refund.reason
      }))

      return {
        success: true,
        message: `Found ${refundRows.length} refund(s) in your history.`,
        data: { refunds: refundSummary }
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error getting refund history')
      return {
        success: false,
        message: 'Error retrieving refund history'
      }
    }
  }

  // Update user profile information
  static async updateUserProfile(userId: string, updates: any): Promise<AdminActionResult> {
    try {
      await db.update(profiles).set(updates).where(eq(profiles.id, userId))

      return {
        success: true,
        message: '✅ Profile updated successfully.',
        data: { updates },
        actionTaken: 'profile_updated'
      }
    } catch (error) {
      logger.error({ error, userId, updates }, 'Error updating user profile')
      return {
        success: false,
        message: 'Error updating profile'
      }
    }
  }

  // Generate comprehensive user report
  static async generateUserReport(userId: string): Promise<AdminActionResult> {
    try {
      const [subscriptionResult, refundResult] = await Promise.all([
        this.checkSubscriptionStatus(userId),
        this.getRefundHistory(userId)
      ])

      const [profile] = await db.select({
        username: profiles.username,
        email: profiles.email,
        created_at: profiles.createdAt,
        first_name: profiles.firstName,
        last_name: profiles.lastName,
      }).from(profiles).where(eq(profiles.id, userId))

      const report = {
        user: {
          id: userId,
          username: profile?.username,
          email: profile?.email,
          name: `${profile?.first_name || ''} ${profile?.last_name || ''}`.trim(),
          memberSince: profile?.created_at
        },
        subscription: subscriptionResult.data || {},
        refunds: refundResult.data?.refunds || [],
        summary: {
          hasActiveSubscription: subscriptionResult.data?.hasActiveSubscription || false,
          totalRefunds: refundResult.data?.refunds?.length || 0,
          eligibleForRefund: false
        }
      }

      // Check current refund eligibility
      if (report.subscription.hasActiveSubscription) {
        const eligibilityResult = await this.checkRefundEligibility(userId)
        report.summary.eligibleForRefund = eligibilityResult.data?.eligible || false
      }

      return {
        success: true,
        message: 'User report generated successfully.',
        data: report
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error generating user report')
      return {
        success: false,
        message: 'Error generating user report'
      }
    }
  }
}
