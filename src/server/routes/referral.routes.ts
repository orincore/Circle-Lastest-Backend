import { Router, Response } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../config/db.js';
import { profiles, referralCodeAttempts, referralPaymentRequests, referralTransactions, userReferrals } from '../db/schema.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { NotificationService } from '../services/notificationService.js';

const router = Router();

// Get user's referral information
router.get('/my-referral', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Get user referral info
    let [data] = await db.select().from(userReferrals).where(eq(userReferrals.userId, userId)).limit(1);

    // If user doesn't have a referral code, create one
    if (!data) {
      //console.log('🔧 Creating referral code for user:', userId);

      // Generate a unique referral code
      let referralCode = '';
      let attempts = 0;
      const maxAttempts = 5;

      while (attempts < maxAttempts) {
        // Try to call the database function first
        try {
          const result = await db.execute(sql`select generate_referral_code() as result`);
          const generatedCode = (result.rows[0] as any)?.result;
          if (generatedCode) {
            referralCode = generatedCode;
            //console.log('✅ Generated code from DB function:', referralCode);
            break;
          }
        } catch (rpcErr) {
          //console.log('⚠️ RPC function not available, using fallback');
        }

        // Fallback: Generate random code
        referralCode = `CIR${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        // Check if code already exists
        const [existing] = await db.select({ id: userReferrals.id }).from(userReferrals).where(eq(userReferrals.referralCode, referralCode)).limit(1);

        if (!existing) {
          //console.log('✅ Generated unique code:', referralCode);
          break;
        }

        attempts++;
      }

      if (!referralCode) {
        console.error('❌ Failed to generate unique referral code');
        return res.status(500).json({ error: 'Failed to generate referral code' });
      }

      // Insert new referral record
      //console.log('💾 Inserting referral record for user:', userId);
      try {
        const [newReferral] = await db.insert(userReferrals)
          .values({
            userId: userId,
            referralCode: referralCode,
            totalReferrals: 0,
            totalEarnings: '0',
            pendingEarnings: '0',
            paidEarnings: '0'
          })
          .returning();

        //console.log('✅ Referral code created successfully:', newReferral);
        data = newReferral;
      } catch (insertError: any) {
        // If duplicate key error, it means another request already created it
        if (insertError?.code === '23505') {
          //console.log('⚠️ Referral code already exists (race condition), fetching existing...');
          const [existingReferral] = await db.select().from(userReferrals).where(eq(userReferrals.userId, userId)).limit(1);

          if (existingReferral) {
            data = existingReferral;
          } else {
            console.error('❌ Failed to fetch existing referral code');
            return res.status(500).json({ error: 'Failed to fetch referral code' });
          }
        } else {
          console.error('❌ Error creating referral code:', insertError);
          console.error('Insert error details:', JSON.stringify(insertError, null, 2));
          return res.status(500).json({ error: 'Failed to create referral code', details: insertError?.message });
        }
      }
    }

    // Get counts by status separately
    const transactions = await db.select({ status: referralTransactions.status })
      .from(referralTransactions)
      .where(eq(referralTransactions.referrerUserId, userId));

    const statusCounts = {
      pending_count: transactions?.filter(t => t.status === 'pending').length || 0,
      approved_count: transactions?.filter(t => t.status === 'approved').length || 0,
      paid_count: transactions?.filter(t => t.status === 'paid').length || 0,
      rejected_count: transactions?.filter(t => t.status === 'rejected').length || 0,
    };

    res.json({ ...data, ...statusCounts });
  } catch (error) {
    console.error('Error fetching referral info:', error);
    res.status(500).json({ error: 'Failed to fetch referral information' });
  }
});

// Get user's referral transactions
router.get('/my-referrals/transactions', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { status } = req.query;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const whereCondition = status
      ? and(eq(referralTransactions.referrerUserId, userId), eq(referralTransactions.status, status as string))
      : eq(referralTransactions.referrerUserId, userId);

    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
      .from(referralTransactions)
      .where(whereCondition);

    const data = await db.select()
      .from(referralTransactions)
      .where(whereCondition)
      .orderBy(desc(referralTransactions.createdAt))
      .limit(limit)
      .offset(offset);

    // Fetch referred user details separately for each transaction
    const transactionsWithUsers = await Promise.all(
      (data || []).map(async (transaction) => {
        const [referredUser] = await db.select({
          username: profiles.username,
          email: profiles.email,
          created_at: profiles.createdAt,
        })
          .from(profiles)
          .where(eq(profiles.id, transaction.referredUserId))
          .limit(1);

        return {
          ...transaction,
          referred_user: referredUser
        };
      })
    );

    res.json({
      transactions: transactionsWithUsers,
      total: count || 0
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// Validate referral code
router.post('/validate-code', async (req: AuthRequest, res: Response) => {
  try {
    const { referralCode } = req.body;

    if (!referralCode) {
      return res.status(400).json({ error: 'Referral code is required' });
    }

    const [data] = await db.select({
      user_id: userReferrals.userId,
      referral_code: userReferrals.referralCode,
      user_username: profiles.username,
      user_email: profiles.email,
    })
      .from(userReferrals)
      .leftJoin(profiles, eq(profiles.id, userReferrals.userId))
      .where(eq(userReferrals.referralCode, referralCode.trim().toUpperCase()))
      .limit(1);

    if (!data) {
      return res.json({ valid: false, message: 'Invalid referral code' });
    }

    res.json({
      valid: true,
      referrer: {
        username: data.user_username,
        code: data.referral_code
      }
    });
  } catch (error) {
    console.error('Error validating referral code:', error);
    res.status(500).json({ error: 'Failed to validate referral code' });
  }
});

// Apply referral code during signup
export async function applyReferralCode(
  referredUserId: string,
  referralCode: string,
  ipAddress?: string,
  userAgent?: string
): Promise<{ success: boolean; referralNumber?: string; error?: string }> {
  try {
    // Validate referral code
    const [referrerData] = await db.select({ user_id: userReferrals.userId })
      .from(userReferrals)
      .where(eq(userReferrals.referralCode, referralCode.trim().toUpperCase()))
      .limit(1);

    if (!referrerData) {
      // Log failed attempt
      await db.insert(referralCodeAttempts).values({
        referralCode: referralCode,
        attemptedByUserId: referredUserId,
        ipAddress: ipAddress,
        userAgent: userAgent,
        success: false,
        failureReason: 'Invalid referral code'
      });

      return { success: false, error: 'Invalid referral code' };
    }

    const referrerId = referrerData.user_id;

    // Check if user is trying to refer themselves
    if (referrerId === referredUserId) {
      await db.insert(referralCodeAttempts).values({
        referralCode: referralCode,
        attemptedByUserId: referredUserId,
        ipAddress: ipAddress,
        userAgent: userAgent,
        success: false,
        failureReason: 'Self-referral not allowed'
      });

      return { success: false, error: 'You cannot use your own referral code' };
    }

    // Check if this referral already exists
    const [existingReferral] = await db.select({ id: referralTransactions.id })
      .from(referralTransactions)
      .where(and(
        eq(referralTransactions.referrerUserId, referrerId),
        eq(referralTransactions.referredUserId, referredUserId)
      ))
      .limit(1);

    if (existingReferral) {
      return { success: false, error: 'Referral already recorded' };
    }

    // Generate unique referral number
    const referralNumber = await generateReferralNumber();

    // Create referral transaction
    try {
      await db.insert(referralTransactions).values({
        referralNumber: referralNumber,
        referrerUserId: referrerId,
        referredUserId: referredUserId,
        referralCode: referralCode,
        status: 'pending'
      });
    } catch (insertError) {
      console.error('Error creating referral transaction:', insertError);
      return { success: false, error: 'Failed to create referral' };
    }

    // Update total_referrals count in user_referrals table
    // NOTE: increment_referral_count(p_user_id uuid) returns void and mutates
    // user_referrals.total_referrals in place - do not call this outside of a
    // real signup flow / live smoke test with a throwaway account.
    //console.log('📊 Updating referral count for user:', referrerId);
    try {
      await db.execute(sql`select increment_referral_count(${referrerId}::uuid)`);
      //console.log('✅ Referral count updated via RPC');
    } catch (updateError) {
      console.warn('⚠️ RPC function not available, using manual update');
      // Fallback: Manual increment
      const [currentData] = await db.select({ totalReferrals: userReferrals.totalReferrals })
        .from(userReferrals)
        .where(eq(userReferrals.userId, referrerId))
        .limit(1);

      const newCount = (currentData?.totalReferrals || 0) + 1;

      await db.update(userReferrals)
        .set({ totalReferrals: newCount })
        .where(eq(userReferrals.userId, referrerId));

      //console.log('✅ Manually updated referral count to:', newCount);
    }

    // Get referred user's name for notification
    const [referredUser] = await db.select({
      firstName: profiles.firstName,
      lastName: profiles.lastName,
    })
      .from(profiles)
      .where(eq(profiles.id, referredUserId))
      .limit(1);

    // Send notification to referrer
    try {
      const referredUserName = referredUser
        ? `${referredUser.firstName} ${referredUser.lastName}`.trim()
        : 'Someone';
      await NotificationService.notifyReferralSignup(
        referrerId,
        referredUserName,
        referralNumber
      );
    } catch (notifError) {
      console.error('Error sending referral signup notification:', notifError);
      // Don't fail the referral if notification fails
    }

    // Log successful attempt
    await db.insert(referralCodeAttempts).values({
      referralCode: referralCode,
      attemptedByUserId: referredUserId,
      ipAddress: ipAddress,
      userAgent: userAgent,
      success: true
    });

    return { success: true, referralNumber };
  } catch (error) {
    console.error('Error applying referral code:', error);
    return { success: false, error: 'Failed to apply referral code' };
  }
}

// Helper function to generate referral number
async function generateReferralNumber(): Promise<string> {
  try {
    const result = await db.execute(sql`select generate_referral_number() as result`);
    const data = (result.rows[0] as any)?.result;
    if (!data) {
      throw new Error('generate_referral_number returned no data');
    }
    return data;
  } catch (error) {
    // Fallback if function doesn't exist
    const year = new Date().getFullYear();
    const random = Math.floor(Math.random() * 999999).toString().padStart(6, '0');
    return `REF-${year}-${random}`;
  }
}

// Update UPI ID
router.post('/update-upi', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { upiId } = req.body;

    if (!upiId || !upiId.match(/^[\w.-]+@[\w.-]+$/)) {
      return res.status(400).json({ error: 'Invalid UPI ID format' });
    }

    try {
      await db.update(userReferrals)
        .set({
          upiId: upiId.trim(),
          upiVerified: false
        })
        .where(eq(userReferrals.userId, userId));
    } catch (error) {
      console.error('Error updating UPI:', error);
      return res.status(500).json({ error: 'Failed to update UPI ID' });
    }

    res.json({ message: 'UPI ID updated successfully', upiId: upiId.trim() });
  } catch (error) {
    console.error('Error updating UPI:', error);
    res.status(500).json({ error: 'Failed to update UPI ID' });
  }
});

// Request payment
router.post('/request-payment', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { amount, upiId } = req.body;

    // Get user's referral info
    const [referralInfo] = await db.select({
      pending_earnings: userReferrals.pendingEarnings,
      upi_id: userReferrals.upiId,
    })
      .from(userReferrals)
      .where(eq(userReferrals.userId, userId))
      .limit(1);

    if (!referralInfo) {
      return res.status(404).json({ error: 'Referral information not found' });
    }

    const { pending_earnings, upi_id } = referralInfo;

    // Validate amount
    if (amount > Number(pending_earnings)) {
      return res.status(400).json({ error: 'Requested amount exceeds pending earnings' });
    }

    if (amount < 100) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is ₹100' });
    }

    // Use provided UPI or existing one
    const finalUpiId = upiId || upi_id;

    if (!finalUpiId) {
      return res.status(400).json({ error: 'UPI ID is required' });
    }

    // Create payment request
    let data;
    try {
      [data] = await db.insert(referralPaymentRequests)
        .values({
          userId: userId,
          upiId: finalUpiId,
          amount: amount,
          status: 'pending'
        })
        .returning();
    } catch (error) {
      console.error('Error creating payment request:', error);
      return res.status(500).json({ error: 'Failed to create payment request' });
    }

    res.json({
      message: 'Payment request submitted successfully. You will receive payment within 7 days after verification.',
      request: data
    });
  } catch (error) {
    console.error('Error requesting payment:', error);
    res.status(500).json({ error: 'Failed to submit payment request' });
  }
});

// Get payment requests
router.get('/payment-requests', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const data = await db.select()
      .from(referralPaymentRequests)
      .where(eq(referralPaymentRequests.userId, userId))
      .orderBy(desc(referralPaymentRequests.createdAt));

    res.json(data || []);
  } catch (error) {
    console.error('Error fetching payment requests:', error);
    res.status(500).json({ error: 'Failed to fetch payment requests' });
  }
});

// Generate shareable referral link
router.get('/share-link', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const [data] = await db.select({ referralCode: userReferrals.referralCode })
      .from(userReferrals)
      .where(eq(userReferrals.userId, userId))
      .limit(1);

    if (!data) {
      return res.status(404).json({ error: 'Referral code not found' });
    }

    const referralCode = data.referralCode;
    const shareLink = `https://circle.orincore.com/signup?ref=${referralCode}`;
    const shareText = `Join Circle and find meaningful connections! Use my referral code ${referralCode} and we both benefit! 🎉\n\n${shareLink}`;

    res.json({
      referralCode,
      shareLink,
      shareText,
      qrCodeUrl: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(shareLink)}`
    });
  } catch (error) {
    console.error('Error generating share link:', error);
    res.status(500).json({ error: 'Failed to generate share link' });
  }
});

// Admin: Get all pending referrals for verification
router.get('/admin/pending', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // TODO: Add admin role check
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const referrerProfiles = profiles;
    // Need two joins to profiles (referrer + referred); alias one of them.
    const referredProfiles = alias(profiles, 'referred_profiles_admin_pending');

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
      referrer_username: referrerProfiles.username,
      referrer_email: referrerProfiles.email,
      referred_username: referredProfiles.username,
      referred_email: referredProfiles.email,
      referred_created_at: referredProfiles.createdAt,
    })
      .from(referralTransactions)
      .leftJoin(referrerProfiles, eq(referrerProfiles.id, referralTransactions.referrerUserId))
      .leftJoin(referredProfiles, eq(referredProfiles.id, referralTransactions.referredUserId))
      .where(eq(referralTransactions.status, 'pending'))
      .orderBy(referralTransactions.createdAt)
      .limit(limit)
      .offset(offset);

    const data = rows.map(r => ({
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
      referrer: { username: r.referrer_username, email: r.referrer_email },
      referred: { username: r.referred_username, email: r.referred_email, created_at: r.referred_created_at },
    }));

    res.json(data || []);
  } catch (error) {
    console.error('Error fetching pending referrals:', error);
    res.status(500).json({ error: 'Failed to fetch pending referrals' });
  }
});

// Admin: Approve/Reject referral
router.post('/admin/verify/:transactionId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // TODO: Add admin role check
    const { transactionId } = req.params;
    const { status, rejectionReason } = req.body;
    const adminId = req.user?.id;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (status === 'rejected' && !rejectionReason) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    // Get transaction details first
    const [transaction] = await db.select().from(referralTransactions).where(eq(referralTransactions.id, transactionId)).limit(1);

    if (!transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    try {
      await db.update(referralTransactions)
        .set({
          status,
          rejectionReason: rejectionReason || null,
          verifiedBy: adminId,
          verifiedAt: new Date().toISOString()
        })
        .where(eq(referralTransactions.id, transactionId));
    } catch (error) {
      console.error('Error verifying referral:', error);
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

    res.json({ message: `Referral ${status} successfully` });
  } catch (error) {
    console.error('Error verifying referral:', error);
    res.status(500).json({ error: 'Failed to verify referral' });
  }
});

// Admin: Mark referral as paid
router.post('/admin/mark-paid/:transactionId', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // TODO: Add admin role check
    const { transactionId } = req.params;
    const { paymentReference } = req.body;

    // Get transaction details first
    const [transaction] = await db.select().from(referralTransactions).where(eq(referralTransactions.id, transactionId)).limit(1);

    if (!transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    try {
      await db.update(referralTransactions)
        .set({
          status: 'paid',
          paymentDate: new Date().toISOString(),
          paymentReference: paymentReference
        })
        .where(and(
          eq(referralTransactions.id, transactionId),
          eq(referralTransactions.status, 'approved')
        ));
    } catch (error) {
      console.error('Error marking referral as paid:', error);
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

    res.json({ message: 'Referral marked as paid successfully' });
  } catch (error) {
    console.error('Error marking referral as paid:', error);
    res.status(500).json({ error: 'Failed to mark referral as paid' });
  }
});

export default router;
