/**
 * Admin Referral Management Routes
 * Handles admin operations for referral system
 */

import express from 'express';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { requireAdmin, AdminRequest } from '../middleware/adminAuth.js';
import { db } from '../config/db.js';
import { adminAuditLogs, profiles, referralPaymentRequests, referralTransactions, userReferrals } from '../db/schema.js';
import { NotificationService } from '../services/notificationService.js';

const router = express.Router();

// ============================================
// Admin Referral Dashboard & Stats
// ============================================

/**
 * Get referral system overview stats
 * GET /api/admin/referrals/stats
 */
router.get('/stats', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    // Total referrals by status
    const statusCounts = await db.select({ status: referralTransactions.status }).from(referralTransactions);

    const stats = {
      total: statusCounts?.length || 0,
      pending: statusCounts?.filter(t => t.status === 'pending').length || 0,
      approved: statusCounts?.filter(t => t.status === 'approved').length || 0,
      paid: statusCounts?.filter(t => t.status === 'paid').length || 0,
      rejected: statusCounts?.filter(t => t.status === 'rejected').length || 0,
    };

    // Total earnings
    const earningsData = await db.select({
      total_earnings: userReferrals.totalEarnings,
      pending_earnings: userReferrals.pendingEarnings,
      paid_earnings: userReferrals.paidEarnings,
    }).from(userReferrals);

    const earnings = earningsData?.reduce((acc, curr) => ({
      total: acc.total + (parseFloat(curr.total_earnings as any) || 0),
      pending: acc.pending + (parseFloat(curr.pending_earnings as any) || 0),
      paid: acc.paid + (parseFloat(curr.paid_earnings as any) || 0),
    }), { total: 0, pending: 0, paid: 0 });

    // Recent referrals (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const [{ count: recentReferrals }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(referralTransactions)
      .where(gte(referralTransactions.createdAt, sevenDaysAgo.toISOString()));

    // Pending payment requests
    const [{ count: pendingPayments }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(referralPaymentRequests)
      .where(eq(referralPaymentRequests.status, 'pending'));

    res.json({
      stats,
      earnings: earnings || { total: 0, pending: 0, paid: 0 },
      recentReferrals: recentReferrals || 0,
      pendingPayments: pendingPayments || 0
    });
  } catch (error) {
    console.error('Error fetching referral stats:', error);
    res.status(500).json({ error: 'Failed to fetch referral statistics' });
  }
});

// ============================================
// Referral Transactions Management
// ============================================

/**
 * Get all referral transactions with filters
 * GET /api/admin/referrals/transactions
 */
router.get('/transactions', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      status,
      page = '1',
      limit = '50',
      search,
      startDate,
      endDate
    } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    const referrerProfiles = alias(profiles, 'referrer_profiles');
    const referredProfiles = alias(profiles, 'referred_profiles');
    const verifiedByProfiles = alias(profiles, 'verified_by_profiles');

    const conditions = [];
    if (status) conditions.push(eq(referralTransactions.status, status as string));
    if (startDate) conditions.push(gte(referralTransactions.createdAt, startDate as string));
    if (endDate) conditions.push(lte(referralTransactions.createdAt, endDate as string));
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(referralTransactions)
      .where(whereCondition);

    const rows = await db.select({
      id: referralTransactions.id,
      referral_number: referralTransactions.referralNumber,
      referrer_user_id: referralTransactions.referrerUserId,
      referred_user_id: referralTransactions.referredUserId,
      referral_code: referralTransactions.referralCode,
      reward_amount: referralTransactions.rewardAmount,
      status: referralTransactions.status,
      rejection_reason: referralTransactions.rejectionReason,
      verified_by: referralTransactions.verifiedBy,
      verified_at: referralTransactions.verifiedAt,
      payment_date: referralTransactions.paymentDate,
      payment_reference: referralTransactions.paymentReference,
      created_at: referralTransactions.createdAt,
      updated_at: referralTransactions.updatedAt,
      referrer_id: referrerProfiles.id,
      referrer_first_name: referrerProfiles.firstName,
      referrer_last_name: referrerProfiles.lastName,
      referrer_email: referrerProfiles.email,
      referrer_username: referrerProfiles.username,
      referrer_photo: referrerProfiles.profilePhotoUrl,
      referred_id: referredProfiles.id,
      referred_first_name: referredProfiles.firstName,
      referred_last_name: referredProfiles.lastName,
      referred_email: referredProfiles.email,
      referred_username: referredProfiles.username,
      referred_photo: referredProfiles.profilePhotoUrl,
      referred_created_at: referredProfiles.createdAt,
      verified_by_id: verifiedByProfiles.id,
      verified_by_first_name: verifiedByProfiles.firstName,
      verified_by_last_name: verifiedByProfiles.lastName,
    })
      .from(referralTransactions)
      .leftJoin(referrerProfiles, eq(referrerProfiles.id, referralTransactions.referrerUserId))
      .leftJoin(referredProfiles, eq(referredProfiles.id, referralTransactions.referredUserId))
      .leftJoin(verifiedByProfiles, eq(verifiedByProfiles.id, referralTransactions.verifiedBy))
      .where(whereCondition)
      .orderBy(desc(referralTransactions.createdAt))
      .limit(limitNum)
      .offset(offset);

    const transactions = rows.map(r => ({
      id: r.id,
      referral_number: r.referral_number,
      referrer_user_id: r.referrer_user_id,
      referred_user_id: r.referred_user_id,
      referral_code: r.referral_code,
      reward_amount: r.reward_amount,
      status: r.status,
      rejection_reason: r.rejection_reason,
      verified_by: r.verified_by,
      verified_at: r.verified_at,
      payment_date: r.payment_date,
      payment_reference: r.payment_reference,
      created_at: r.created_at,
      updated_at: r.updated_at,
      referrer: r.referrer_id ? {
        id: r.referrer_id,
        first_name: r.referrer_first_name,
        last_name: r.referrer_last_name,
        email: r.referrer_email,
        username: r.referrer_username,
        profile_photo_url: r.referrer_photo,
      } : null,
      referred: r.referred_id ? {
        id: r.referred_id,
        first_name: r.referred_first_name,
        last_name: r.referred_last_name,
        email: r.referred_email,
        username: r.referred_username,
        profile_photo_url: r.referred_photo,
        created_at: r.referred_created_at,
      } : null,
      verified_by_user: r.verified_by_id ? {
        id: r.verified_by_id,
        first_name: r.verified_by_first_name,
        last_name: r.verified_by_last_name,
      } : null,
    }));

    // Fetch UPI IDs for referrers
    const transactionsWithUPI = await Promise.all(
      transactions.map(async (transaction) => {
        const [upiData] = await db.select({
          upi_id: userReferrals.upiId,
          upi_verified: userReferrals.upiVerified,
        })
          .from(userReferrals)
          .where(eq(userReferrals.userId, transaction.referrer_user_id))
          .limit(1);

        return {
          ...transaction,
          referrer_upi_id: upiData?.upi_id || null,
          referrer_upi_verified: upiData?.upi_verified || false
        };
      })
    );

    res.json({
      transactions: transactionsWithUPI,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching referral transactions:', error);
    res.status(500).json({ error: 'Failed to fetch referral transactions' });
  }
});

/**
 * Get pending referrals for verification
 * GET /api/admin/referrals/pending
 */
router.get('/pending', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;

    const referrerProfiles = alias(profiles, 'referrer_profiles_pending');
    const referredProfiles = alias(profiles, 'referred_profiles_pending');

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(referralTransactions)
      .where(eq(referralTransactions.status, 'pending'));

    const rows = await db.select({
      id: referralTransactions.id,
      referral_number: referralTransactions.referralNumber,
      referrer_user_id: referralTransactions.referrerUserId,
      referred_user_id: referralTransactions.referredUserId,
      referral_code: referralTransactions.referralCode,
      reward_amount: referralTransactions.rewardAmount,
      status: referralTransactions.status,
      rejection_reason: referralTransactions.rejectionReason,
      verified_by: referralTransactions.verifiedBy,
      verified_at: referralTransactions.verifiedAt,
      payment_date: referralTransactions.paymentDate,
      payment_reference: referralTransactions.paymentReference,
      created_at: referralTransactions.createdAt,
      updated_at: referralTransactions.updatedAt,
      referrer_id: referrerProfiles.id,
      referrer_first_name: referrerProfiles.firstName,
      referrer_last_name: referrerProfiles.lastName,
      referrer_email: referrerProfiles.email,
      referrer_username: referrerProfiles.username,
      referrer_photo: referrerProfiles.profilePhotoUrl,
      referred_id: referredProfiles.id,
      referred_first_name: referredProfiles.firstName,
      referred_last_name: referredProfiles.lastName,
      referred_email: referredProfiles.email,
      referred_username: referredProfiles.username,
      referred_photo: referredProfiles.profilePhotoUrl,
      referred_created_at: referredProfiles.createdAt,
    })
      .from(referralTransactions)
      .leftJoin(referrerProfiles, eq(referrerProfiles.id, referralTransactions.referrerUserId))
      .leftJoin(referredProfiles, eq(referredProfiles.id, referralTransactions.referredUserId))
      .where(eq(referralTransactions.status, 'pending'))
      .orderBy(referralTransactions.createdAt)
      .limit(limit)
      .offset(offset);

    const transactions = rows.map(r => ({
      id: r.id,
      referral_number: r.referral_number,
      referrer_user_id: r.referrer_user_id,
      referred_user_id: r.referred_user_id,
      referral_code: r.referral_code,
      reward_amount: r.reward_amount,
      status: r.status,
      rejection_reason: r.rejection_reason,
      verified_by: r.verified_by,
      verified_at: r.verified_at,
      payment_date: r.payment_date,
      payment_reference: r.payment_reference,
      created_at: r.created_at,
      updated_at: r.updated_at,
      referrer: r.referrer_id ? {
        id: r.referrer_id,
        first_name: r.referrer_first_name,
        last_name: r.referrer_last_name,
        email: r.referrer_email,
        username: r.referrer_username,
        profile_photo_url: r.referrer_photo,
      } : null,
      referred: r.referred_id ? {
        id: r.referred_id,
        first_name: r.referred_first_name,
        last_name: r.referred_last_name,
        email: r.referred_email,
        username: r.referred_username,
        profile_photo_url: r.referred_photo,
        created_at: r.referred_created_at,
      } : null,
    }));

    // Fetch UPI IDs for referrers
    const transactionsWithUPI = await Promise.all(
      transactions.map(async (transaction) => {
        const [upiData] = await db.select({
          upi_id: userReferrals.upiId,
          upi_verified: userReferrals.upiVerified,
        })
          .from(userReferrals)
          .where(eq(userReferrals.userId, transaction.referrer_user_id))
          .limit(1);

        return {
          ...transaction,
          referrer_upi_id: upiData?.upi_id || null,
          referrer_upi_verified: upiData?.upi_verified || false
        };
      })
    );

    res.json({
      transactions: transactionsWithUPI,
      total: count || 0
    });
  } catch (error) {
    console.error('Error fetching pending referrals:', error);
    res.status(500).json({ error: 'Failed to fetch pending referrals' });
  }
});

/**
 * Verify referral (approve/reject)
 * POST /api/admin/referrals/:transactionId/verify
 */
router.post('/:transactionId/verify', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { transactionId } = req.params;
    const { status, rejectionReason } = req.body;
    const adminId = req.user!.id;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be approved or rejected' });
    }

    if (status === 'rejected' && !rejectionReason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    // Get transaction details first
    const [transaction] = await db.select({
      id: referralTransactions.id,
      referrerUserId: referralTransactions.referrerUserId,
      referralNumber: referralTransactions.referralNumber,
      rewardAmount: referralTransactions.rewardAmount,
      status: referralTransactions.status,
    })
      .from(referralTransactions)
      .where(eq(referralTransactions.id, transactionId))
      .limit(1);

    if (!transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    if (transaction.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending referrals can be verified' });
    }

    // Update transaction status
    try {
      await db.update(referralTransactions)
        .set({
          status,
          rejectionReason: rejectionReason || null,
          verifiedBy: adminId,
          verifiedAt: new Date().toISOString()
        })
        .where(eq(referralTransactions.id, transactionId));
    } catch (updateError) {
      console.error('Error verifying referral:', updateError);
      return res.status(500).json({ error: 'Failed to verify referral' });
    }

    // Send notification to user
    try {
      if (status === 'approved') {
        await NotificationService.notifyReferralApproved(
          transaction.referrerUserId,
          transaction.referralNumber,
          parseFloat(transaction.rewardAmount as any) || 10
        );
      } else {
        await NotificationService.notifyReferralRejected(
          transaction.referrerUserId,
          transaction.referralNumber,
          rejectionReason
        );
      }
    } catch (notifError) {
      console.error('Error sending notification:', notifError);
      // Don't fail the request if notification fails
    }

    res.json({
      success: true,
      message: `Referral ${status} successfully`
    });
  } catch (error) {
    console.error('Error verifying referral:', error);
    res.status(500).json({ error: 'Failed to verify referral' });
  }
});

/**
 * Update referral transaction details
 * PUT /api/admin/referrals/:transactionId/update
 */
router.put('/:transactionId/update', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { transactionId } = req.params;
    const { reward_amount, notes } = req.body;
    const adminId = req.user!.id;

    // Get transaction details first
    const [transaction] = await db.select().from(referralTransactions).where(eq(referralTransactions.id, transactionId)).limit(1);

    if (!transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    // Prepare update object
    const updates: any = {
      updatedAt: new Date().toISOString()
    };

    if (reward_amount !== undefined && reward_amount !== null) {
      updates.rewardAmount = reward_amount;
    }

    if (notes !== undefined) {
      updates.notes = notes;
    }

    // Update transaction
    try {
      await db.update(referralTransactions)
        .set(updates)
        .where(eq(referralTransactions.id, transactionId));
    } catch (updateError) {
      console.error('Error updating referral:', updateError);
      return res.status(500).json({ error: 'Failed to update referral' });
    }

    // Log admin action
    await db.insert(adminAuditLogs).values({
      adminId: adminId,
      action: 'update_referral',
      targetType: 'referral_transaction',
      targetId: transactionId,
      details: { updates, old_values: { reward_amount: transaction.rewardAmount } }
    });

    res.json({
      success: true,
      message: 'Referral updated successfully'
    });
  } catch (error) {
    console.error('Error updating referral:', error);
    res.status(500).json({ error: 'Failed to update referral' });
  }
});

/**
 * Change referral status
 * POST /api/admin/referrals/:transactionId/change-status
 */
router.post('/:transactionId/change-status', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { transactionId } = req.params;
    const { status } = req.body;
    const adminId = req.user!.id;

    // Validate status
    if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Get transaction details first
    const [transaction] = await db.select().from(referralTransactions).where(eq(referralTransactions.id, transactionId)).limit(1);

    if (!transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    const oldStatus = transaction.status;

    // Update transaction status
    try {
      await db.update(referralTransactions)
        .set({
          status,
          verifiedBy: adminId,
          verifiedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
        .where(eq(referralTransactions.id, transactionId));
    } catch (updateError) {
      console.error('Error changing status:', updateError);
      return res.status(500).json({ error: 'Failed to change status' });
    }

    // Log admin action
    await db.insert(adminAuditLogs).values({
      adminId: adminId,
      action: 'change_referral_status',
      targetType: 'referral_transaction',
      targetId: transactionId,
      details: { old_status: oldStatus, new_status: status }
    });

    // Send notification based on new status
    try {
      if (status === 'approved') {
        await NotificationService.notifyReferralApproved(
          transaction.referrerUserId,
          transaction.referralNumber,
          parseFloat(transaction.rewardAmount as any) || 10
        );
      } else if (status === 'rejected') {
        await NotificationService.notifyReferralRejected(
          transaction.referrerUserId,
          transaction.referralNumber,
          'Status changed by admin'
        );
      } else if (status === 'paid') {
        await NotificationService.notifyReferralPaid(
          transaction.referrerUserId,
          transaction.referralNumber,
          parseFloat(transaction.rewardAmount as any) || 10,
          'Admin status change'
        );
      }
    } catch (notifError) {
      console.error('Error sending notification:', notifError);
      // Don't fail the request if notification fails
    }

    res.json({
      success: true,
      message: `Status changed from ${oldStatus} to ${status} successfully`
    });
  } catch (error) {
    console.error('Error changing status:', error);
    res.status(500).json({ error: 'Failed to change status' });
  }
});

/**
 * Mark referral as paid
 * POST /api/admin/referrals/:transactionId/mark-paid
 */
router.post('/:transactionId/mark-paid', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { transactionId } = req.params;
    const { paymentReference } = req.body;

    // Get transaction details first
    const [transaction] = await db.select().from(referralTransactions).where(eq(referralTransactions.id, transactionId)).limit(1);

    if (!transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    if (transaction.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved referrals can be marked as paid' });
    }

    // Update transaction to paid
    try {
      await db.update(referralTransactions)
        .set({
          status: 'paid',
          paymentDate: new Date().toISOString(),
          paymentReference: paymentReference
        })
        .where(eq(referralTransactions.id, transactionId));
    } catch (updateError) {
      console.error('Error marking referral as paid:', updateError);
      return res.status(500).json({ error: 'Failed to mark referral as paid' });
    }

    // Send notification to user
    try {
      await NotificationService.notifyReferralPaid(
        transaction.referrerUserId,
        transaction.referralNumber,
        parseFloat(transaction.rewardAmount as any) || 10,
        paymentReference
      );
    } catch (notifError) {
      console.error('Error sending notification:', notifError);
      // Don't fail the request if notification fails
    }

    res.json({
      success: true,
      message: 'Referral marked as paid successfully'
    });
  } catch (error) {
    console.error('Error marking referral as paid:', error);
    res.status(500).json({ error: 'Failed to mark referral as paid' });
  }
});

// ============================================
// Payment Requests Management
// ============================================

/**
 * Get all payment requests
 * GET /api/admin/referrals/payment-requests
 */
router.get('/payment-requests', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const {
      status,
      page = '1',
      limit = '50'
    } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    const userProfiles = alias(profiles, 'payment_request_user_profiles');
    const processedByProfiles = alias(profiles, 'payment_request_processed_by_profiles');

    const whereCondition = status ? eq(referralPaymentRequests.status, status as string) : undefined;

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(referralPaymentRequests)
      .where(whereCondition);

    const rows = await db.select({
      id: referralPaymentRequests.id,
      user_id: referralPaymentRequests.userId,
      upi_id: referralPaymentRequests.upiId,
      amount: referralPaymentRequests.amount,
      status: referralPaymentRequests.status,
      request_date: referralPaymentRequests.requestDate,
      processed_date: referralPaymentRequests.processedDate,
      processed_by: referralPaymentRequests.processedBy,
      payment_reference: referralPaymentRequests.paymentReference,
      notes: referralPaymentRequests.notes,
      created_at: referralPaymentRequests.createdAt,
      updated_at: referralPaymentRequests.updatedAt,
      user_ref_id: userProfiles.id,
      user_first_name: userProfiles.firstName,
      user_last_name: userProfiles.lastName,
      user_email: userProfiles.email,
      user_username: userProfiles.username,
      user_photo: userProfiles.profilePhotoUrl,
      processed_by_id: processedByProfiles.id,
      processed_by_first_name: processedByProfiles.firstName,
      processed_by_last_name: processedByProfiles.lastName,
    })
      .from(referralPaymentRequests)
      .leftJoin(userProfiles, eq(userProfiles.id, referralPaymentRequests.userId))
      .leftJoin(processedByProfiles, eq(processedByProfiles.id, referralPaymentRequests.processedBy))
      .where(whereCondition)
      .orderBy(desc(referralPaymentRequests.createdAt))
      .limit(limitNum)
      .offset(offset);

    const requests = rows.map(r => ({
      id: r.id,
      user_id: r.user_id,
      upi_id: r.upi_id,
      amount: r.amount,
      status: r.status,
      request_date: r.request_date,
      processed_date: r.processed_date,
      processed_by: r.processed_by,
      payment_reference: r.payment_reference,
      notes: r.notes,
      created_at: r.created_at,
      updated_at: r.updated_at,
      user: r.user_ref_id ? {
        id: r.user_ref_id,
        first_name: r.user_first_name,
        last_name: r.user_last_name,
        email: r.user_email,
        username: r.user_username,
        profile_photo_url: r.user_photo,
      } : null,
      processed_by_user: r.processed_by_id ? {
        id: r.processed_by_id,
        first_name: r.processed_by_first_name,
        last_name: r.processed_by_last_name,
      } : null,
    }));

    res.json({
      requests: requests || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching payment requests:', error);
    res.status(500).json({ error: 'Failed to fetch payment requests' });
  }
});

/**
 * Process payment request
 * POST /api/admin/referrals/payment-requests/:requestId/process
 */
router.post('/payment-requests/:requestId/process', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { requestId } = req.params;
    const { status, paymentReference, notes } = req.body;
    const adminId = req.user!.id;

    if (!['completed', 'failed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be completed or failed' });
    }

    try {
      await db.update(referralPaymentRequests)
        .set({
          status,
          processedDate: new Date().toISOString(),
          processedBy: adminId,
          paymentReference: paymentReference,
          notes
        })
        .where(eq(referralPaymentRequests.id, requestId));
    } catch (error) {
      console.error('Error processing payment request:', error);
      return res.status(500).json({ error: 'Failed to process payment request' });
    }

    res.json({
      success: true,
      message: `Payment request ${status} successfully`
    });
  } catch (error) {
    console.error('Error processing payment request:', error);
    res.status(500).json({ error: 'Failed to process payment request' });
  }
});

// ============================================
// User Referral Management
// ============================================

/**
 * Get user's referral details
 * GET /api/admin/referrals/user/:userId
 */
router.get('/user/:userId', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { userId } = req.params;

    // Get user's referral info
    const [referralInfo] = await db.select().from(userReferrals).where(eq(userReferrals.userId, userId)).limit(1);

    if (!referralInfo) {
      return res.status(404).json({ error: 'User referral information not found' });
    }

    // Get user's referral transactions
    const referredProfiles = alias(profiles, 'user_referral_referred_profiles');

    let transactions: any[] = [];
    try {
      const rows = await db.select({
        id: referralTransactions.id,
        referral_number: referralTransactions.referralNumber,
        referrer_user_id: referralTransactions.referrerUserId,
        referred_user_id: referralTransactions.referredUserId,
        referral_code: referralTransactions.referralCode,
        reward_amount: referralTransactions.rewardAmount,
        status: referralTransactions.status,
        rejection_reason: referralTransactions.rejectionReason,
        verified_by: referralTransactions.verifiedBy,
        verified_at: referralTransactions.verifiedAt,
        payment_date: referralTransactions.paymentDate,
        payment_reference: referralTransactions.paymentReference,
        created_at: referralTransactions.createdAt,
        updated_at: referralTransactions.updatedAt,
        referred_id: referredProfiles.id,
        referred_first_name: referredProfiles.firstName,
        referred_last_name: referredProfiles.lastName,
        referred_email: referredProfiles.email,
        referred_created_at: referredProfiles.createdAt,
      })
        .from(referralTransactions)
        .leftJoin(referredProfiles, eq(referredProfiles.id, referralTransactions.referredUserId))
        .where(eq(referralTransactions.referrerUserId, userId))
        .orderBy(desc(referralTransactions.createdAt));

      transactions = rows.map(r => ({
        id: r.id,
        referral_number: r.referral_number,
        referrer_user_id: r.referrer_user_id,
        referred_user_id: r.referred_user_id,
        referral_code: r.referral_code,
        reward_amount: r.reward_amount,
        status: r.status,
        rejection_reason: r.rejection_reason,
        verified_by: r.verified_by,
        verified_at: r.verified_at,
        payment_date: r.payment_date,
        payment_reference: r.payment_reference,
        created_at: r.created_at,
        updated_at: r.updated_at,
        referred: r.referred_id ? {
          id: r.referred_id,
          first_name: r.referred_first_name,
          last_name: r.referred_last_name,
          email: r.referred_email,
          created_at: r.referred_created_at,
        } : null,
      }));
    } catch (transError) {
      console.error('Error fetching user transactions:', transError);
    }

    // Get payment requests
    let paymentRequests: any[] = [];
    try {
      paymentRequests = await db.select()
        .from(referralPaymentRequests)
        .where(eq(referralPaymentRequests.userId, userId))
        .orderBy(desc(referralPaymentRequests.createdAt));
    } catch (paymentError) {
      console.error('Error fetching payment requests:', paymentError);
    }

    res.json({
      referralInfo,
      transactions: transactions || [],
      paymentRequests: paymentRequests || []
    });
  } catch (error) {
    console.error('Error fetching user referral details:', error);
    res.status(500).json({ error: 'Failed to fetch user referral details' });
  }
});

/**
 * Get referral analytics
 * GET /api/admin/referrals/analytics
 */
router.get('/analytics', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { startDate, endDate } = req.query;

    const conditions = [];
    if (startDate) conditions.push(gte(referralTransactions.createdAt, startDate as string));
    if (endDate) conditions.push(lte(referralTransactions.createdAt, endDate as string));
    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const transactions = await db.select({
      created_at: referralTransactions.createdAt,
      status: referralTransactions.status,
      reward_amount: referralTransactions.rewardAmount,
    })
      .from(referralTransactions)
      .where(whereCondition);

    // Group by date
    const dailyStats = transactions?.reduce((acc: any, t: any) => {
      const date = new Date(t.created_at).toISOString().split('T')[0];
      if (!acc[date]) {
        acc[date] = { date, total: 0, approved: 0, rejected: 0, paid: 0, amount: 0 };
      }
      acc[date].total++;
      acc[date][t.status]++;
      if (t.status === 'paid') {
        acc[date].amount += parseFloat(t.reward_amount || 0);
      }
      return acc;
    }, {});

    res.json({
      dailyStats: Object.values(dailyStats || {}),
      summary: {
        totalReferrals: transactions?.length || 0,
        totalAmount: transactions?.reduce((sum: number, t: any) =>
          t.status === 'paid' ? sum + parseFloat(t.reward_amount || 0) : sum, 0) || 0
      }
    });
  } catch (error) {
    console.error('Error fetching referral analytics:', error);
    res.status(500).json({ error: 'Failed to fetch referral analytics' });
  }
});

export default router;
