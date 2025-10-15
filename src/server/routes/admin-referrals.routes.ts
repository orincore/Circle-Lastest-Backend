/**
 * Admin Referral Management Routes
 * Handles admin operations for referral system
 */

import express from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { requireAdmin, AdminRequest } from '../middleware/adminAuth.js';
import { supabase } from '../config/supabase.js';
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
    const { data: statusCounts } = await supabase
      .from('referral_transactions')
      .select('status');

    const stats = {
      total: statusCounts?.length || 0,
      pending: statusCounts?.filter(t => t.status === 'pending').length || 0,
      approved: statusCounts?.filter(t => t.status === 'approved').length || 0,
      paid: statusCounts?.filter(t => t.status === 'paid').length || 0,
      rejected: statusCounts?.filter(t => t.status === 'rejected').length || 0,
    };

    // Total earnings
    const { data: earningsData } = await supabase
      .from('user_referrals')
      .select('total_earnings, pending_earnings, paid_earnings');

    const earnings = earningsData?.reduce((acc, curr) => ({
      total: acc.total + (parseFloat(curr.total_earnings as any) || 0),
      pending: acc.pending + (parseFloat(curr.pending_earnings as any) || 0),
      paid: acc.paid + (parseFloat(curr.paid_earnings as any) || 0),
    }), { total: 0, pending: 0, paid: 0 });

    // Recent referrals (last 7 days)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const { count: recentReferrals } = await supabase
      .from('referral_transactions')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', sevenDaysAgo.toISOString());

    // Pending payment requests
    const { count: pendingPayments } = await supabase
      .from('referral_payment_requests')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending');

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

    let query = supabase
      .from('referral_transactions')
      .select(`
        *,
        referrer:profiles!referrer_user_id(
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url
        ),
        referred:profiles!referred_user_id(
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url,
          created_at
        ),
        verified_by_user:profiles!verified_by(
          id,
          first_name,
          last_name
        )
      `, { count: 'exact' });

    // Apply filters
    if (status) {
      query = query.eq('status', status);
    }
    if (startDate) {
      query = query.gte('created_at', startDate);
    }
    if (endDate) {
      query = query.lte('created_at', endDate);
    }

    const { data: transactions, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (error) {
      console.error('Error fetching referral transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch referral transactions' });
    }

    res.json({
      transactions: transactions || [],
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

    const { data: transactions, error, count } = await supabase
      .from('referral_transactions')
      .select(`
        *,
        referrer:profiles!referrer_user_id(
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url
        ),
        referred:profiles!referred_user_id(
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url,
          created_at
        )
      `, { count: 'exact' })
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Error fetching pending referrals:', error);
      return res.status(500).json({ error: 'Failed to fetch pending referrals' });
    }

    res.json({
      transactions: transactions || [],
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
    const { data: transaction, error: fetchError } = await supabase
      .from('referral_transactions')
      .select('*, referrer:profiles!referrer_user_id(first_name, last_name)')
      .eq('id', transactionId)
      .single();

    if (fetchError || !transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    if (transaction.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending referrals can be verified' });
    }

    // Update transaction status
    const { error: updateError } = await supabase
      .from('referral_transactions')
      .update({
        status,
        rejection_reason: rejectionReason || null,
        verified_by: adminId,
        verified_at: new Date().toISOString()
      })
      .eq('id', transactionId);

    if (updateError) {
      console.error('Error verifying referral:', updateError);
      return res.status(500).json({ error: 'Failed to verify referral' });
    }

    // Send notification to user
    try {
      if (status === 'approved') {
        await NotificationService.notifyReferralApproved(
          transaction.referrer_user_id,
          transaction.referral_number,
          parseFloat(transaction.reward_amount as any) || 10
        );
      } else {
        await NotificationService.notifyReferralRejected(
          transaction.referrer_user_id,
          transaction.referral_number,
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
 * Mark referral as paid
 * POST /api/admin/referrals/:transactionId/mark-paid
 */
router.post('/:transactionId/mark-paid', requireAuth, requireAdmin, async (req: AdminRequest, res) => {
  try {
    const { transactionId } = req.params;
    const { paymentReference } = req.body;

    // Get transaction details first
    const { data: transaction, error: fetchError } = await supabase
      .from('referral_transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (fetchError || !transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    if (transaction.status !== 'approved') {
      return res.status(400).json({ error: 'Only approved referrals can be marked as paid' });
    }

    // Update transaction to paid
    const { error: updateError } = await supabase
      .from('referral_transactions')
      .update({
        status: 'paid',
        payment_date: new Date().toISOString(),
        payment_reference: paymentReference
      })
      .eq('id', transactionId);

    if (updateError) {
      console.error('Error marking referral as paid:', updateError);
      return res.status(500).json({ error: 'Failed to mark referral as paid' });
    }

    // Send notification to user
    try {
      await NotificationService.notifyReferralPaid(
        transaction.referrer_user_id,
        transaction.referral_number,
        parseFloat(transaction.reward_amount as any) || 10,
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

    let query = supabase
      .from('referral_payment_requests')
      .select(`
        *,
        user:profiles!user_id(
          id,
          first_name,
          last_name,
          email,
          username,
          profile_photo_url
        ),
        processed_by_user:profiles!processed_by(
          id,
          first_name,
          last_name
        )
      `, { count: 'exact' });

    if (status) {
      query = query.eq('status', status);
    }

    const { data: requests, error, count } = await query
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1);

    if (error) {
      console.error('Error fetching payment requests:', error);
      return res.status(500).json({ error: 'Failed to fetch payment requests' });
    }

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

    const { error } = await supabase
      .from('referral_payment_requests')
      .update({
        status,
        processed_date: new Date().toISOString(),
        processed_by: adminId,
        payment_reference: paymentReference,
        notes
      })
      .eq('id', requestId);

    if (error) {
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
    const { data: referralInfo, error: referralError } = await supabase
      .from('user_referrals')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (referralError) {
      return res.status(404).json({ error: 'User referral information not found' });
    }

    // Get user's referral transactions
    const { data: transactions, error: transError } = await supabase
      .from('referral_transactions')
      .select(`
        *,
        referred:profiles!referred_user_id(
          id,
          first_name,
          last_name,
          email,
          created_at
        )
      `)
      .eq('referrer_user_id', userId)
      .order('created_at', { ascending: false });

    if (transError) {
      console.error('Error fetching user transactions:', transError);
    }

    // Get payment requests
    const { data: paymentRequests, error: paymentError } = await supabase
      .from('referral_payment_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (paymentError) {
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

    let query = supabase
      .from('referral_transactions')
      .select('created_at, status, reward_amount');

    if (startDate) {
      query = query.gte('created_at', startDate as string);
    }
    if (endDate) {
      query = query.lte('created_at', endDate as string);
    }

    const { data: transactions } = await query;

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
