/**
 * Cashfree Subscription Payment Routes
 * Handles Cashfree payment integration for ₹10/month and ₹50/year subscriptions
 */

import express from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.js';
import { cashfreeClient, validateCashfreeConfig } from '../config/cashfree.js';
import { SUBSCRIPTION_PLANS, getPlanById, getDurationInDays } from '../config/subscription-plans.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import crypto from 'crypto';

const router = express.Router();

// Validate Cashfree configuration on startup
if (!validateCashfreeConfig()) {
  logger.warn('Cashfree payment gateway not configured properly');
}

/**
 * Get available subscription plans
 * GET /api/cashfree/plans
 */
router.get('/plans', (req, res) => {
  try {
    res.json({
      plans: SUBSCRIPTION_PLANS,
      currency: 'INR'
    });
  } catch (error) {
    logger.error({ error }, 'Error fetching subscription plans');
    res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

/**
 * Create payment order
 * POST /api/cashfree/create-order
 */
router.post('/create-order', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { planId } = req.body;
    const userId = req.user!.id;

    // Validate plan
    const plan = getPlanById(planId);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    // Get user details
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name, email, phone_number')
      .eq('id', userId)
      .single();

    if (!profile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    // Create Cashfree order (v2023-08-01 API format)
    const orderRequest = {
      order_amount: plan.price,
      order_currency: 'INR',
      customer_details: {
        customer_id: userId,
        customer_name: `${profile.first_name} ${profile.last_name}`.trim() || 'User',
        customer_email: profile.email,
        customer_phone: profile.phone_number || '9999999999'
      },
      order_meta: {
        return_url: `${process.env.FRONTEND_URL}/subscription/verify?order_id={order_id}`,
        notify_url: `${process.env.API_BASE_URL}/api/cashfree/webhook`
      }
    };

    const response = await cashfreeClient.post('/orders', orderRequest);
    
    // Use Cashfree's generated order_id
    const cfOrderId = response.data.order_id;

    // Store order in database
    await supabase.from('payment_orders').insert({
      order_id: cfOrderId,
      user_id: userId,
      plan_id: planId,
      amount: plan.price,
      currency: 'INR',
      status: 'created',
      gateway: 'cashfree',
      gateway_order_id: response.data.cf_order_id,
      created_at: new Date().toISOString()
    });

    logger.info({ userId, cfOrderId, planId, amount: plan.price }, 'Cashfree order created');

    res.json({
      success: true,
      order_id: cfOrderId,
      payment_session_id: response.data.payment_session_id,
      cf_order_id: response.data.cf_order_id,
      order_amount: plan.price,
      order_currency: 'INR'
    });

  } catch (error) {
    logger.error({ error }, 'Error creating Cashfree order');
    res.status(500).json({ error: 'Failed to create payment order' });
  }
});

/**
 * Verify payment
 * POST /api/cashfree/verify-payment
 */
router.post('/verify-payment', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { orderId } = req.body;
    const userId = req.user!.id;

    // Get order from database
    const { data: order, error: orderError } = await supabase
      .from('payment_orders')
      .select('*')
      .eq('order_id', orderId)
      .eq('user_id', userId)
      .single();

    if (orderError || !order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Fetch order status from Cashfree
    const response = await cashfreeClient.get(`/orders/${orderId}/payments`);

    if (!response.data || response.data.length === 0) {
      return res.status(400).json({ error: 'No payment found for this order' });
    }

    const payment = response.data[0];
    const paymentStatus = payment.payment_status;

    // Update order status
    await supabase
      .from('payment_orders')
      .update({
        status: paymentStatus.toLowerCase(),
        gateway_payment_id: payment.cf_payment_id,
        payment_method: payment.payment_group,
        updated_at: new Date().toISOString()
      })
      .eq('order_id', orderId);

    // If payment successful, create/update subscription
    if (paymentStatus === 'SUCCESS') {
      const plan = getPlanById(order.plan_id);
      if (!plan) {
        return res.status(400).json({ error: 'Invalid plan' });
      }

      const durationDays = getDurationInDays(order.plan_id);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + durationDays);

      // Check if user has existing subscription
      const { data: existingSub } = await supabase
        .from('user_subscriptions')
        .select('*')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();

      if (existingSub) {
        // Extend existing subscription
        const currentExpiry = new Date(existingSub.expires_at);
        const newExpiry = currentExpiry > new Date() 
          ? new Date(currentExpiry.getTime() + durationDays * 24 * 60 * 60 * 1000)
          : expiresAt;

        await supabase
          .from('user_subscriptions')
          .update({
            plan_type: plan.duration,
            expires_at: newExpiry.toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', existingSub.id);
      } else {
        // Create new subscription
        await supabase.from('user_subscriptions').insert({
          user_id: userId,
          plan_type: plan.duration,
          status: 'active',
          started_at: new Date().toISOString(),
          expires_at: expiresAt.toISOString(),
          payment_gateway: 'cashfree',
          gateway_subscription_id: order.gateway_order_id,
          amount: order.amount,
          currency: 'INR'
        });
      }

      // Record transaction
      await supabase.from('subscription_transactions').insert({
        user_id: userId,
        order_id: orderId,
        amount: order.amount,
        currency: 'INR',
        status: 'completed',
        payment_method: payment.payment_group,
        gateway: 'cashfree',
        gateway_transaction_id: payment.cf_payment_id,
        created_at: new Date().toISOString()
      });

      logger.info({ userId, orderId, planId: order.plan_id }, 'Subscription activated successfully');

      return res.json({
        success: true,
        message: 'Payment verified and subscription activated',
        subscription: {
          plan: plan.name,
          expires_at: expiresAt.toISOString()
        }
      });
    }

    res.json({
      success: false,
      status: paymentStatus,
      message: `Payment status: ${paymentStatus}`
    });

  } catch (error) {
    logger.error({ error }, 'Error verifying payment');
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

/**
 * Webhook handler for Cashfree
 * POST /api/cashfree/webhook
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'] as string;
    const timestamp = req.headers['x-webhook-timestamp'] as string;
    
    // Verify webhook signature
    const payload = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', process.env.CASHFREE_SECRET_KEY || '')
      .update(timestamp + payload)
      .digest('base64');

    if (signature !== expectedSignature) {
      logger.warn('Invalid webhook signature');
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = req.body;
    const { type, data } = event;

    logger.info({ type, orderId: data.order?.order_id }, 'Cashfree webhook received');

    // Handle different webhook events
    switch (type) {
      case 'PAYMENT_SUCCESS_WEBHOOK':
        await handlePaymentSuccess(data);
        break;
      case 'PAYMENT_FAILED_WEBHOOK':
        await handlePaymentFailed(data);
        break;
      case 'PAYMENT_USER_DROPPED_WEBHOOK':
        await handlePaymentDropped(data);
        break;
      default:
        logger.info({ type }, 'Unhandled webhook event type');
    }

    res.json({ success: true });
  } catch (error) {
    logger.error({ error }, 'Error processing webhook');
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// Helper functions for webhook handling
async function handlePaymentSuccess(data: any) {
  const orderId = data.order.order_id;
  
  // Get order details from database
  const { data: order, error: orderError } = await supabase
    .from('payment_orders')
    .select('*')
    .eq('order_id', orderId)
    .single();

  if (orderError || !order) {
    logger.error({ orderId, error: orderError }, 'Order not found for webhook');
    return;
  }

  // Update payment order status
  await supabase
    .from('payment_orders')
    .update({
      status: 'success',
      gateway_payment_id: data.payment.cf_payment_id,
      payment_method: data.payment.payment_group,
      updated_at: new Date().toISOString()
    })
    .eq('order_id', orderId);

  // Get plan details
  const plan = getPlanById(order.plan_id);
  if (!plan) {
    logger.error({ orderId, planId: order.plan_id }, 'Invalid plan for order');
    return;
  }

  const durationDays = getDurationInDays(order.plan_id);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + durationDays);

  // Check if user has existing active subscription
  const { data: existingSub } = await supabase
    .from('user_subscriptions')
    .select('*')
    .eq('user_id', order.user_id)
    .eq('status', 'active')
    .single();

  if (existingSub) {
    // Extend existing subscription
    const currentExpiry = new Date(existingSub.expires_at);
    const newExpiry = currentExpiry > new Date() 
      ? new Date(currentExpiry.getTime() + durationDays * 24 * 60 * 60 * 1000)
      : expiresAt;

    await supabase
      .from('user_subscriptions')
      .update({
        plan_type: plan.duration,
        expires_at: newExpiry.toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', existingSub.id);

    logger.info({ orderId, userId: order.user_id, newExpiry }, 'Subscription extended via webhook');
  } else {
    // Create new subscription
    await supabase.from('user_subscriptions').insert({
      user_id: order.user_id,
      plan_type: plan.duration,
      status: 'active',
      started_at: new Date().toISOString(),
      expires_at: expiresAt.toISOString(),
      payment_gateway: 'cashfree',
      gateway_subscription_id: order.gateway_order_id,
      amount: order.amount,
      currency: 'INR'
    });

    logger.info({ orderId, userId: order.user_id, expiresAt }, 'New subscription created via webhook');
  }

  // Record transaction
  await supabase.from('subscription_transactions').insert({
    user_id: order.user_id,
    order_id: orderId,
    amount: order.amount,
    currency: 'INR',
    status: 'completed',
    payment_method: data.payment.payment_group,
    gateway: 'cashfree',
    gateway_transaction_id: data.payment.cf_payment_id,
    created_at: new Date().toISOString()
  });

  // Update profile premium status (trigger will handle this, but we can do it explicitly too)
  await supabase
    .from('profiles')
    .update({
      is_premium: true,
      subscription_expires_at: expiresAt.toISOString()
    })
    .eq('id', order.user_id);

  logger.info({ orderId, userId: order.user_id, planId: order.plan_id }, 'Payment success webhook processed - subscription activated');
}

async function handlePaymentFailed(data: any) {
  const orderId = data.order.order_id;
  
  await supabase
    .from('payment_orders')
    .update({
      status: 'failed',
      failure_reason: data.payment.payment_message,
      updated_at: new Date().toISOString()
    })
    .eq('order_id', orderId);

  logger.info({ orderId }, 'Payment failed webhook processed');
}

async function handlePaymentDropped(data: any) {
  const orderId = data.order.order_id;
  
  await supabase
    .from('payment_orders')
    .update({
      status: 'cancelled',
      updated_at: new Date().toISOString()
    })
    .eq('order_id', orderId);

  logger.info({ orderId }, 'Payment dropped webhook processed');
}

/**
 * Get user's subscription status
 * GET /api/cashfree/subscription-status
 */
router.get('/subscription-status', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    // Check for active or cancelled subscriptions (cancelled users keep access until expiry)
    const { data: subscription } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['active', 'cancelled'])
      .single();

    if (!subscription) {
      return res.json({
        is_subscribed: false,
        plan: null
      });
    }

    const isExpired = new Date(subscription.expires_at) < new Date();
    if (isExpired) {
      await supabase
        .from('user_subscriptions')
        .update({ status: 'expired' })
        .eq('id', subscription.id);

      return res.json({
        is_subscribed: false,
        plan: null
      });
    }

    res.json({
      is_subscribed: true,
      plan: subscription.plan_type,
      expires_at: subscription.expires_at,
      started_at: subscription.started_at,
      status: subscription.status,
      is_cancelled: subscription.status === 'cancelled',
      cancelled_at: subscription.cancelled_at
    });

  } catch (error) {
    logger.error({ error }, 'Error fetching subscription status');
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

/**
 * Cancel subscription (No refund policy)
 * POST /api/cashfree/cancel-subscription
 */
router.post('/cancel-subscription', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    // Get active subscription
    const { data: subscription, error: fetchError } = await supabase
      .from('user_subscriptions')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (fetchError || !subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    // Cancel the subscription (no refund - subscription remains active until expiry)
    const { error: cancelError } = await supabase
      .from('user_subscriptions')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        auto_renew: false,
        updated_at: new Date().toISOString()
      })
      .eq('id', subscription.id);

    if (cancelError) {
      logger.error({ error: cancelError, userId }, 'Error cancelling subscription');
      return res.status(500).json({ error: 'Failed to cancel subscription' });
    }

    // Update profile to remove premium status after expiry
    // Note: User keeps premium access until expires_at date
    await supabase
      .from('profiles')
      .update({
        subscription_expires_at: subscription.expires_at
      })
      .eq('id', userId);

    logger.info({ 
      userId, 
      subscriptionId: subscription.id,
      expiresAt: subscription.expires_at 
    }, 'Subscription cancelled - access remains until expiry date');

    res.json({
      success: true,
      message: 'Subscription cancelled successfully. You will retain access until the end of your billing period.',
      expires_at: subscription.expires_at,
      no_refund: true
    });

  } catch (error) {
    logger.error({ error }, 'Error cancelling subscription');
    res.status(500).json({ error: 'Failed to cancel subscription' });
  }
});

export default router;
