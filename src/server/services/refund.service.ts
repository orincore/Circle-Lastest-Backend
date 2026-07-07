import { and, desc, eq, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../config/db.js'
import { refunds, userSubscriptions, profiles } from '../db/schema.js'
import { logger } from '../config/logger.js'
import { getRazorpayClient, isRazorpayConfigured } from '../config/razorpay.js'
import EmailService from './emailService.js'

export interface Refund {
  id: string
  subscription_id: string
  user_id: string
  amount: number
  currency: string
  reason?: string | null
  status: 'pending' | 'approved' | 'rejected' | 'processed' | 'failed'
  requested_at: string
  processed_at?: string | null
  processed_by?: string | null
  payment_provider?: string | null
  external_refund_id?: string | null
  refund_method: string
  admin_notes?: string | null
  transaction_id?: string | null
  // Relations from joins
  subscription?: { plan_type: string; started_at: string; external_subscription_id?: string | null } | null
  user?: { username: string | null; email: string | null } | null
  processed_by_profile?: { username: string | null } | null
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

const processedByProfiles = alias(profiles, 'refund_processed_by_profiles')
const userProfiles = alias(profiles, 'refund_user_profiles')

interface RefundJoinRow {
  id: string
  subscription_id: string
  user_id: string
  amount: string
  currency: string | null
  reason: string | null
  status: string
  requested_at: string
  processed_at: string | null
  processed_by: string | null
  payment_provider: string | null
  external_refund_id: string | null
  refund_method: string | null
  admin_notes: string | null
  transaction_id: string | null
  sub_plan_id: string | null
  sub_started_at: string | null
  sub_apple_original_transaction_id: string | null
  sub_google_purchase_token: string | null
  sub_razorpay_subscription_id: string | null
  sub_source: string | null
  user_username: string | null
  user_email: string | null
  processed_by_username: string | null
}

function baseRefundSelect() {
  return {
    id: refunds.id,
    subscription_id: refunds.subscriptionId,
    user_id: refunds.userId,
    amount: refunds.amount,
    currency: refunds.currency,
    reason: refunds.reason,
    status: refunds.status,
    requested_at: refunds.requestedAt,
    processed_at: refunds.processedAt,
    processed_by: refunds.processedBy,
    payment_provider: refunds.paymentProvider,
    external_refund_id: refunds.externalRefundId,
    refund_method: refunds.refundMethod,
    admin_notes: refunds.adminNotes,
    transaction_id: refunds.transactionId,
    sub_plan_id: userSubscriptions.planId,
    sub_started_at: userSubscriptions.startedAt,
    sub_apple_original_transaction_id: userSubscriptions.appleOriginalTransactionId,
    sub_google_purchase_token: userSubscriptions.googlePurchaseToken,
    sub_razorpay_subscription_id: userSubscriptions.razorpaySubscriptionId,
    sub_source: userSubscriptions.source,
    user_username: userProfiles.username,
    user_email: userProfiles.email,
    processed_by_username: processedByProfiles.username,
  }
}

function mapRefundRow(row: RefundJoinRow): Refund {
  return {
    id: row.id,
    subscription_id: row.subscription_id,
    user_id: row.user_id,
    amount: Number(row.amount),
    currency: row.currency || 'INR',
    reason: row.reason,
    status: row.status as Refund['status'],
    requested_at: row.requested_at,
    processed_at: row.processed_at,
    processed_by: row.processed_by,
    payment_provider: row.payment_provider,
    external_refund_id: row.external_refund_id,
    refund_method: row.refund_method || 'original_payment_method',
    admin_notes: row.admin_notes,
    transaction_id: row.transaction_id,
    subscription: row.sub_plan_id ? {
      plan_type: row.sub_plan_id,
      started_at: row.sub_started_at!,
      external_subscription_id: row.sub_apple_original_transaction_id || row.sub_google_purchase_token || row.sub_razorpay_subscription_id || null,
    } : null,
    user: row.user_username !== null ? { username: row.user_username, email: row.user_email } : null,
    processed_by_profile: row.processed_by_username !== null ? { username: row.processed_by_username } : null,
  }
}

export class RefundService {
  // Request a refund for a subscription
  static async requestRefund(
    userId: string,
    subscriptionId: string,
    reason?: string
  ): Promise<Refund> {
    try {
      const [subscription] = await db.select().from(userSubscriptions)
        .where(and(eq(userSubscriptions.id, subscriptionId), eq(userSubscriptions.userId, userId)))
        .limit(1)

      if (!subscription) {
        throw new Error('Subscription not found or does not belong to user')
      }

      const isEligible = await this.checkRefundEligibility(subscriptionId)
      if (!isEligible) {
        throw new Error('Subscription is not eligible for refund. Refunds are only available within 7 days of purchase.')
      }

      const [existingRefund] = await db.select({ id: refunds.id }).from(refunds)
        .where(and(eq(refunds.subscriptionId, subscriptionId), eq(refunds.status, 'pending')))
        .limit(1)

      if (existingRefund) {
        throw new Error('Refund request already pending for this subscription')
      }

      const [refund] = await db.insert(refunds).values({
        subscriptionId,
        userId,
        amount: subscription.amount || '0',
        currency: subscription.currency || 'INR',
        reason: reason || 'User requested refund',
        paymentProvider: subscription.source,
        refundMethod: 'original_payment_method',
      }).returning()

      try {
        const [userProfile] = await db.select({ email: profiles.email, username: profiles.username })
          .from(profiles).where(eq(profiles.id, userId)).limit(1)

        if (userProfile?.email) {
          await EmailService.sendRefundRequestConfirmation(
            userProfile.email,
            userProfile.username || 'User',
            subscription.planId,
            Number(refund.amount),
            refund.currency || 'INR',
            refund.id
          )
        }
      } catch (emailError) {
        logger.warn({ error: emailError, userId, refundId: refund.id }, 'Failed to send refund confirmation email')
      }

      logger.info({ userId, subscriptionId, refundId: refund.id }, 'Refund request created')
      return {
        id: refund.id,
        subscription_id: refund.subscriptionId,
        user_id: refund.userId,
        amount: Number(refund.amount),
        currency: refund.currency || 'INR',
        reason: refund.reason,
        status: refund.status as Refund['status'],
        requested_at: refund.requestedAt,
        processed_at: refund.processedAt,
        processed_by: refund.processedBy,
        payment_provider: refund.paymentProvider,
        external_refund_id: refund.externalRefundId,
        refund_method: refund.refundMethod || 'original_payment_method',
        admin_notes: refund.adminNotes,
        transaction_id: refund.transactionId,
        subscription: {
          plan_type: subscription.planId,
          started_at: subscription.startedAt,
          external_subscription_id: subscription.appleOriginalTransactionId || subscription.googlePurchaseToken || subscription.razorpaySubscriptionId || null,
        },
      }
    } catch (error) {
      logger.error({ error, userId, subscriptionId }, 'Error requesting refund')
      throw error
    }
  }

  // Get a single refund by id
  static async getRefundById(refundId: string): Promise<Refund | null> {
    try {
      const [row] = await db.select(baseRefundSelect())
        .from(refunds)
        .leftJoin(userSubscriptions, eq(userSubscriptions.id, refunds.subscriptionId))
        .leftJoin(userProfiles, eq(userProfiles.id, refunds.userId))
        .leftJoin(processedByProfiles, eq(processedByProfiles.id, refunds.processedBy))
        .where(eq(refunds.id, refundId))
        .limit(1)

      return row ? mapRefundRow(row) : null
    } catch (error) {
      logger.error({ error, refundId }, 'Error getting refund by id')
      throw error
    }
  }

  // Get user's refund requests
  static async getUserRefunds(userId: string): Promise<Refund[]> {
    try {
      const rows = await db.select(baseRefundSelect())
        .from(refunds)
        .leftJoin(userSubscriptions, eq(userSubscriptions.id, refunds.subscriptionId))
        .leftJoin(userProfiles, eq(userProfiles.id, refunds.userId))
        .leftJoin(processedByProfiles, eq(processedByProfiles.id, refunds.processedBy))
        .where(eq(refunds.userId, userId))
        .orderBy(desc(refunds.requestedAt))

      return rows.map(mapRefundRow)
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
      const whereClause = status ? eq(refunds.status, status) : undefined

      const rows = await db.select(baseRefundSelect())
        .from(refunds)
        .leftJoin(userSubscriptions, eq(userSubscriptions.id, refunds.subscriptionId))
        .leftJoin(userProfiles, eq(userProfiles.id, refunds.userId))
        .leftJoin(processedByProfiles, eq(processedByProfiles.id, refunds.processedBy))
        .where(whereClause)
        .orderBy(desc(refunds.requestedAt))
        .limit(limit)
        .offset(offset)

      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(refunds).where(whereClause)

      return {
        refunds: rows.map(mapRefundRow),
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
      const [row] = await db.select(baseRefundSelect())
        .from(refunds)
        .leftJoin(userSubscriptions, eq(userSubscriptions.id, refunds.subscriptionId))
        .leftJoin(userProfiles, eq(userProfiles.id, refunds.userId))
        .leftJoin(processedByProfiles, eq(processedByProfiles.id, refunds.processedBy))
        .where(eq(refunds.id, refundId))
        .limit(1)

      if (!row) {
        throw new Error('Refund not found')
      }

      if (row.status !== 'pending') {
        throw new Error('Refund has already been processed')
      }

      const newStatus = action === 'approve' ? 'approved' : 'rejected'
      const processedAt = new Date().toISOString()

      await db.update(refunds)
        .set({
          status: newStatus,
          processedAt,
          processedBy: adminUserId,
          adminNotes: adminNotes || null,
        })
        .where(eq(refunds.id, refundId))

      const refund = mapRefundRow({
        ...row,
        status: newStatus,
        processed_at: processedAt,
        processed_by: adminUserId,
        admin_notes: adminNotes || null,
      })

      try {
        if (row.user_email) {
          if (action === 'approve') {
            await EmailService.sendRefundApprovalEmail(row.user_email, row.user_username || 'User', row.sub_plan_id || '', Number(refund.amount), refund.currency)
          } else {
            await EmailService.sendRefundRejectionEmail(row.user_email, row.user_username || 'User', row.sub_plan_id || '', adminNotes || 'No reason provided')
          }
        }
      } catch (emailError) {
        logger.warn({ error: emailError, refundId }, 'Failed to send refund status email')
      }

      logger.info({ refundId, action, adminUserId }, 'Refund processed')
      return refund
    } catch (error) {
      logger.error({ error, refundId, action }, 'Error processing refund')
      throw error
    }
  }

  // Actually move money: only Razorpay (web) supports server-initiated refunds via API.
  // App Store / Play Store purchases must be refunded by the platform itself
  // (App Store Connect / Play Console) -- there is no equivalent server API call.
  static async processPaymentRefund(refund: Refund): Promise<{ id: string }> {
    try {
      if (refund.payment_provider === 'web') {
        if (!isRazorpayConfigured()) {
          throw new Error('Razorpay is not configured; cannot process web refund automatically')
        }
        const paymentId = refund.subscription?.external_subscription_id
        if (!paymentId) {
          throw new Error('Missing Razorpay payment id for this subscription')
        }

        const razorpay = getRazorpayClient()
        const razorpayRefund = await razorpay.payments.refund(paymentId, {
          amount: Math.round(refund.amount * 100),
        })

        await db.update(refunds).set({
          status: 'processed',
          externalRefundId: razorpayRefund.id,
          adminNotes: `${refund.admin_notes || ''}\nPayment refund processed via Razorpay. External ID: ${razorpayRefund.id}`,
        }).where(eq(refunds.id, refund.id))

        logger.info({ refundId: refund.id, externalRefundId: razorpayRefund.id }, 'Razorpay refund processed')
        return { id: razorpayRefund.id }
      }

      // ios / android: no API-triggered refund is possible.
      throw new Error(
        `Automatic refund processing is not available for ${refund.payment_provider} purchases. ` +
        'Process this refund manually in App Store Connect / Google Play Console, then update this record.'
      )
    } catch (error) {
      logger.error({ error, refundId: refund.id }, 'Error processing payment refund')
      throw error
    }
  }

  // Get refund statistics for admin dashboard
  static async getRefundStats(): Promise<RefundStats> {
    try {
      const result = await db.execute(sql`SELECT get_refund_stats() AS stats`)
      const stats = (result.rows[0] as any)?.stats

      return stats || {
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
      const result = await db.execute(sql`SELECT is_refund_eligible(${subscriptionId}::uuid) AS eligible`)
      return Boolean((result.rows[0] as any)?.eligible)
    } catch (error) {
      logger.error({ error, subscriptionId }, 'Error checking refund eligibility')
      return false
    }
  }
}
