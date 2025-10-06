import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { PaymentGateway } from './payment.service.js'
import EmailService from './emailService.js'

export interface Refund {
  id: string
  subscription_id: string
  user_id: string
  amount: number
  currency: string
  reason?: string
  status: 'pending' | 'approved' | 'rejected' | 'processed' | 'failed'
  requested_at: Date
  processed_at?: Date
  processed_by?: string
  payment_provider?: string
  external_refund_id?: string
  refund_method: string
  admin_notes?: string
  // Relations from joins
  subscription?: any
  user?: any
}

export interface RefundRequest {
  subscription_id: string
  reason?: string
}

export interface RefundStats {
  total_requests: number
  pending: number
  approved: number
  rejected: number
  processed: number
  failed: number
  total_amount: number
  pending_amount: number
}

export class RefundService {
  // Request a refund for a subscription
  static async requestRefund(
    userId: string,
    subscriptionId: string,
    reason?: string
  ): Promise<Refund> {
    try {
      // Check if subscription exists and belongs to user
      const { data: subscription, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('id', subscriptionId)
        .eq('user_id', userId)
        .single()

      if (subError || !subscription) {
        throw new Error('Subscription not found or does not belong to user')
      }

      // Check if subscription is eligible for refund
      const { data: isEligible, error: eligibilityError } = await supabase
        .rpc('is_refund_eligible', { subscription_uuid: subscriptionId })

      if (eligibilityError) {
        throw new Error('Error checking refund eligibility')
      }

      if (!isEligible) {
        throw new Error('Subscription is not eligible for refund. Refunds are only available within 7 days of purchase and for premium subscriptions.')
      }

      // Check if refund already requested
      const { data: existingRefund } = await supabase
        .from('refunds')
        .select('id, status')
        .eq('subscription_id', subscriptionId)
        .eq('status', 'pending')
        .single()

      if (existingRefund) {
        throw new Error('Refund request already pending for this subscription')
      }

      // Create refund request
      const { data: refund, error: refundError } = await supabase
        .from('refunds')
        .insert({
          subscription_id: subscriptionId,
          user_id: userId,
          amount: subscription.price_paid || 0,
          currency: subscription.currency || 'USD',
          reason: reason || 'User requested refund',
          payment_provider: subscription.payment_provider,
          refund_method: 'original_payment_method'
        })
        .select()
        .single()

      if (refundError) {
        throw refundError
      }

      // Send notification email to user
      try {
        const { data: userProfile } = await supabase
          .from('profiles')
          .select('email, username')
          .eq('id', userId)
          .single()

        if (userProfile?.email) {
          await EmailService.sendRefundRequestConfirmation(
            userProfile.email,
            userProfile.username || 'User',
            subscription.plan_type,
            refund.amount,
            refund.currency,
            refund.id
          )
        }
      } catch (emailError) {
        logger.warn({ error: emailError, userId, refundId: refund.id }, 'Failed to send refund confirmation email')
      }

      logger.info({ userId, subscriptionId, refundId: refund.id }, 'Refund request created')
      return refund
    } catch (error) {
      logger.error({ error, userId, subscriptionId }, 'Error requesting refund')
      throw error
    }
  }

  // Get user's refund requests
  static async getUserRefunds(userId: string): Promise<Refund[]> {
    try {
      const { data, error } = await supabase
        .from('refunds')
        .select(`
          *,
          subscription:subscriptions(plan_type, started_at),
          processed_by_profile:profiles!refunds_processed_by_fkey(username)
        `)
        .eq('user_id', userId)
        .order('requested_at', { ascending: false })

      if (error) throw error
      return data || []
    } catch (error) {
      logger.error({ error, userId }, 'Error getting user refunds')
      throw error
    }
  }

  // Admin: Get all refund requests
  static async getAllRefunds(
    status?: string,
    limit = 50,
    offset = 0
  ): Promise<{ refunds: Refund[]; total: number }> {
    try {
      let query = supabase
        .from('refunds')
        .select(`
          *,
          subscription:subscriptions(plan_type, started_at, external_subscription_id),
          user:profiles!refunds_user_id_fkey(username, email),
          processed_by_profile:profiles!refunds_processed_by_fkey(username)
        `, { count: 'exact' })
        .order('requested_at', { ascending: false })

      if (status) {
        query = query.eq('status', status)
      }

      const { data, error, count } = await query
        .range(offset, offset + limit - 1)

      if (error) throw error

      return {
        refunds: data || [],
        total: count || 0
      }
    } catch (error) {
      logger.error({ error }, 'Error getting all refunds')
      throw error
    }
  }

  // Admin: Process refund (approve/reject)
  static async processRefund(
    refundId: string,
    adminUserId: string,
    action: 'approve' | 'reject',
    adminNotes?: string
  ): Promise<Refund> {
    try {
      // Get refund details
      const { data: refund, error: refundError } = await supabase
        .from('refunds')
        .select(`
          *,
          subscription:subscriptions(*),
          user:profiles!refunds_user_id_fkey(username, email)
        `)
        .eq('id', refundId)
        .single()

      if (refundError || !refund) {
        throw new Error('Refund not found')
      }

      if (refund.status !== 'pending') {
        throw new Error('Refund has already been processed')
      }

      const newStatus = action === 'approve' ? 'approved' : 'rejected'

      // Update refund status
      const { data: updatedRefund, error: updateError } = await supabase
        .from('refunds')
        .update({
          status: newStatus,
          processed_at: new Date().toISOString(),
          processed_by: adminUserId,
          admin_notes: adminNotes
        })
        .eq('id', refundId)
        .select()
        .single()

      if (updateError) {
        throw updateError
      }

      // If approved, process the actual refund through payment gateway
      if (action === 'approve') {
        try {
          await this.processPaymentRefund(updatedRefund)
        } catch (paymentError) {
          // Mark refund as failed if payment processing fails
          const errorMessage = paymentError instanceof Error ? paymentError.message : 'Unknown payment error'
          await supabase
            .from('refunds')
            .update({
              status: 'failed',
              admin_notes: `Payment processing failed: ${errorMessage}`
            })
            .eq('id', refundId)

          throw new Error(`Refund approved but payment processing failed: ${errorMessage}`)
        }
      }

      // Send notification email to user
      try {
        if (refund.user?.email) {
          if (action === 'approve') {
            await EmailService.sendRefundApprovalEmail(
              refund.user.email,
              refund.user.username || 'User',
              refund.subscription.plan_type,
              refund.amount,
              refund.currency
            )
          } else {
            await EmailService.sendRefundRejectionEmail(
              refund.user.email,
              refund.user.username || 'User',
              refund.subscription.plan_type,
              adminNotes || 'No reason provided'
            )
          }
        }
      } catch (emailError) {
        logger.warn({ error: emailError, refundId }, 'Failed to send refund status email')
      }

      logger.info({ refundId, action, adminUserId }, 'Refund processed')
      return updatedRefund
    } catch (error) {
      logger.error({ error, refundId, action }, 'Error processing refund')
      throw error
    }
  }

  // Process actual payment refund through payment gateway
  private static async processPaymentRefund(refund: Refund): Promise<void> {
    try {
      if (!refund.payment_provider || !refund.subscription?.external_subscription_id) {
        throw new Error('Missing payment provider or external subscription ID')
      }

      // Process refund through payment gateway
      const paymentRefund = await PaymentGateway.processRefund(
        refund.subscription.external_subscription_id,
        refund.amount,
        refund.currency
      )

      // Update refund with payment gateway response
      await supabase
        .from('refunds')
        .update({
          status: 'processed',
          external_refund_id: paymentRefund.id,
          admin_notes: `Payment refund processed successfully. External ID: ${paymentRefund.id}`
        })
        .eq('id', refund.id)

      logger.info({ refundId: refund.id, externalRefundId: paymentRefund.id }, 'Payment refund processed')
    } catch (error) {
      logger.error({ error, refundId: refund.id }, 'Error processing payment refund')
      throw error
    }
  }

  // Get refund statistics for admin dashboard
  static async getRefundStats(): Promise<RefundStats> {
    try {
      const { data, error } = await supabase.rpc('get_refund_stats')

      if (error) throw error

      return data || {
        total_requests: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        processed: 0,
        failed: 0,
        total_amount: 0,
        pending_amount: 0
      }
    } catch (error) {
      logger.error({ error }, 'Error getting refund stats')
      throw error
    }
  }

  // Check if subscription is eligible for refund
  static async checkRefundEligibility(subscriptionId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .rpc('is_refund_eligible', { subscription_uuid: subscriptionId })

      if (error) throw error
      return data || false
    } catch (error) {
      logger.error({ error, subscriptionId }, 'Error checking refund eligibility')
      return false
    }
  }
}
