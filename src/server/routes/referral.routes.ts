import { Router, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { NotificationService } from '../services/notificationService.js';

const router = Router();

// Get user's referral information
router.get('/my-referral', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Get user referral info
    let { data, error } = await supabase
      .from('user_referrals')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    // If user doesn't have a referral code, create one
    if (!data) {
      console.log('🔧 Creating referral code for user:', userId);
      
      // Generate a unique referral code
      let referralCode = '';
      let attempts = 0;
      const maxAttempts = 5;
      
      while (attempts < maxAttempts) {
        // Try to call the database function first
        try {
          const { data: generatedCode, error: rpcError } = await supabase.rpc('generate_referral_code');
          if (generatedCode && !rpcError) {
            referralCode = generatedCode;
            console.log('✅ Generated code from DB function:', referralCode);
            break;
          }
        } catch (rpcErr) {
          console.log('⚠️ RPC function not available, using fallback');
        }
        
        // Fallback: Generate random code
        referralCode = `CIR${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
        
        // Check if code already exists
        const { data: existing } = await supabase
          .from('user_referrals')
          .select('id')
          .eq('referral_code', referralCode)
          .maybeSingle();
        
        if (!existing) {
          console.log('✅ Generated unique code:', referralCode);
          break;
        }
        
        attempts++;
      }
      
      if (!referralCode) {
        console.error('❌ Failed to generate unique referral code');
        return res.status(500).json({ error: 'Failed to generate referral code' });
      }
      
      // Insert new referral record
      console.log('💾 Inserting referral record for user:', userId);
      const { data: newReferral, error: insertError } = await supabase
        .from('user_referrals')
        .insert({
          user_id: userId,
          referral_code: referralCode,
          total_referrals: 0,
          total_earnings: 0,
          pending_earnings: 0,
          paid_earnings: 0
        })
        .select()
        .single();

      if (insertError) {
        console.error('❌ Error creating referral code:', insertError);
        console.error('Insert error details:', JSON.stringify(insertError, null, 2));
        return res.status(500).json({ error: 'Failed to create referral code', details: insertError.message });
      }

      console.log('✅ Referral code created successfully:', newReferral);
      data = newReferral;
    } else if (error) {
      console.error('❌ Error fetching referral info:', error);
      return res.status(500).json({ error: 'Failed to fetch referral information' });
    }

    // Get counts by status separately
    const { data: transactions } = await supabase
      .from('referral_transactions')
      .select('status')
      .eq('referrer_user_id', userId);

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

    let query = supabase
      .from('referral_transactions')
      .select('*', { count: 'exact' })
      .eq('referrer_user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching transactions:', error);
      return res.status(500).json({ error: 'Failed to fetch transactions' });
    }

    // Fetch referred user details separately for each transaction
    const transactionsWithUsers = await Promise.all(
      (data || []).map(async (transaction) => {
        const { data: referredUser } = await supabase
          .from('profiles')
          .select('username, email, created_at')
          .eq('id', transaction.referred_user_id)
          .single();

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

    const { data, error } = await supabase
      .from('user_referrals')
      .select(`
        user_id,
        referral_code,
        user:profiles!user_id(username, email)
      `)
      .eq('referral_code', referralCode.trim().toUpperCase())
      .single();

    if (error || !data) {
      return res.json({ valid: false, message: 'Invalid referral code' });
    }

    res.json({
      valid: true,
      referrer: {
        username: (data.user as any)?.username,
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
    const { data: referrerData, error: referrerError } = await supabase
      .from('user_referrals')
      .select('user_id')
      .eq('referral_code', referralCode.trim().toUpperCase())
      .single();

    if (referrerError || !referrerData) {
      // Log failed attempt
      await supabase.from('referral_code_attempts').insert({
        referral_code: referralCode,
        attempted_by_user_id: referredUserId,
        ip_address: ipAddress,
        user_agent: userAgent,
        success: false,
        failure_reason: 'Invalid referral code'
      });
      
      return { success: false, error: 'Invalid referral code' };
    }

    const referrerId = referrerData.user_id;

    // Check if user is trying to refer themselves
    if (referrerId === referredUserId) {
      await supabase.from('referral_code_attempts').insert({
        referral_code: referralCode,
        attempted_by_user_id: referredUserId,
        ip_address: ipAddress,
        user_agent: userAgent,
        success: false,
        failure_reason: 'Self-referral not allowed'
      });
      
      return { success: false, error: 'You cannot use your own referral code' };
    }

    // Check if this referral already exists
    const { data: existingReferral } = await supabase
      .from('referral_transactions')
      .select('id')
      .eq('referrer_user_id', referrerId)
      .eq('referred_user_id', referredUserId)
      .single();

    if (existingReferral) {
      return { success: false, error: 'Referral already recorded' };
    }

    // Generate unique referral number
    const referralNumber = await generateReferralNumber();

    // Create referral transaction
    const { error: insertError } = await supabase
      .from('referral_transactions')
      .insert({
        referral_number: referralNumber,
        referrer_user_id: referrerId,
        referred_user_id: referredUserId,
        referral_code: referralCode,
        status: 'pending'
      });

    if (insertError) {
      console.error('Error creating referral transaction:', insertError);
      return { success: false, error: 'Failed to create referral' };
    }

    // Get referred user's name for notification
    const { data: referredUser } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('id', referredUserId)
      .single();

    // Send notification to referrer
    try {
      const referredUserName = referredUser 
        ? `${referredUser.first_name} ${referredUser.last_name}`.trim() 
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
    await supabase.from('referral_code_attempts').insert({
      referral_code: referralCode,
      attempted_by_user_id: referredUserId,
      ip_address: ipAddress,
      user_agent: userAgent,
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
  const { data, error } = await supabase.rpc('generate_referral_number');
  if (error || !data) {
    // Fallback if function doesn't exist
    const year = new Date().getFullYear();
    const random = Math.floor(Math.random() * 999999).toString().padStart(6, '0');
    return `REF-${year}-${random}`;
  }
  return data;
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

    const { error } = await supabase
      .from('user_referrals')
      .update({
        upi_id: upiId.trim(),
        upi_verified: false
      })
      .eq('user_id', userId);

    if (error) {
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
    const { data: referralInfo, error: fetchError } = await supabase
      .from('user_referrals')
      .select('pending_earnings, upi_id')
      .eq('user_id', userId)
      .single();

    if (fetchError || !referralInfo) {
      return res.status(404).json({ error: 'Referral information not found' });
    }

    const { pending_earnings, upi_id } = referralInfo;

    // Validate amount
    if (amount > pending_earnings) {
      return res.status(400).json({ error: 'Requested amount exceeds pending earnings' });
    }

    if (amount < 10) {
      return res.status(400).json({ error: 'Minimum withdrawal amount is ₹10' });
    }

    // Use provided UPI or existing one
    const finalUpiId = upiId || upi_id;
    
    if (!finalUpiId) {
      return res.status(400).json({ error: 'UPI ID is required' });
    }

    // Create payment request
    const { data, error } = await supabase
      .from('referral_payment_requests')
      .insert({
        user_id: userId,
        upi_id: finalUpiId,
        amount,
        status: 'pending'
      })
      .select()
      .single();

    if (error) {
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

    const { data, error } = await supabase
      .from('referral_payment_requests')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Error fetching payment requests:', error);
      return res.status(500).json({ error: 'Failed to fetch payment requests' });
    }

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

    const { data, error } = await supabase
      .from('user_referrals')
      .select('referral_code')
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Referral code not found' });
    }

    const referralCode = data.referral_code;
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

    const { data, error } = await supabase
      .from('referral_transactions')
      .select(`
        *,
        referrer:profiles!referrer_user_id(username, email),
        referred:profiles!referred_user_id(username, email, created_at)
      `)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      console.error('Error fetching pending referrals:', error);
      return res.status(500).json({ error: 'Failed to fetch pending referrals' });
    }

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
    const { data: transaction, error: fetchError } = await supabase
      .from('referral_transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (fetchError || !transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    const { error } = await supabase
      .from('referral_transactions')
      .update({
        status,
        rejection_reason: rejectionReason || null,
        verified_by: adminId,
        verified_at: new Date().toISOString()
      })
      .eq('id', transactionId);

    if (error) {
      console.error('Error verifying referral:', error);
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
    const { data: transaction, error: fetchError } = await supabase
      .from('referral_transactions')
      .select('*')
      .eq('id', transactionId)
      .single();

    if (fetchError || !transaction) {
      return res.status(404).json({ error: 'Referral transaction not found' });
    }

    const { error } = await supabase
      .from('referral_transactions')
      .update({
        status: 'paid',
        payment_date: new Date().toISOString(),
        payment_reference: paymentReference
      })
      .eq('id', transactionId)
      .eq('status', 'approved');

    if (error) {
      console.error('Error marking referral as paid:', error);
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

    res.json({ message: 'Referral marked as paid successfully' });
  } catch (error) {
    console.error('Error marking referral as paid:', error);
    res.status(500).json({ error: 'Failed to mark referral as paid' });
  }
});

export default router;
