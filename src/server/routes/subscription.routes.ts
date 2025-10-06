import express from 'express'
import { SubscriptionService } from '../services/subscription.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { PaymentGateway } from '../services/payment.service.js'
import { logger } from '../config/logger.js'
import EmailService from '../services/emailService.js'

const router = express.Router()

// Get current user's subscription
router.get('/current', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Debug: Log what we're checking
    const subscription = await SubscriptionService.getUserSubscription(userId)
    const plan = await SubscriptionService.getUserPlan(userId)
    const isPremium = await SubscriptionService.isPremiumUser(userId)
    const matchLimit = await SubscriptionService.checkDailyMatchLimit(userId)

    res.json({
      subscription,
      plan,
      is_premium: isPremium,
      match_limit: matchLimit
    })
  } catch (error) {
    logger.error({ error }, 'Error getting current subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Cancel subscription
router.post('/cancel', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Get current active subscription
    const subscription = await SubscriptionService.getActiveSubscription(userId)
    
    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' })
    }
    
    // Cancel the subscription
    await SubscriptionService.cancelSubscription(userId)
    
    res.json({
      message: 'Subscription cancelled successfully'
    })
  } catch (error) {
    logger.error({ error }, 'Error cancelling subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get subscription plans and pricing
router.get('/plans', async (req, res) => {
  try {
    const plans = [
      {
        id: 'free',
        name: 'Free',
        price: 0,
        currency: 'USD',
        interval: 'forever',
        features: [
          '3 matches per day',
          'Basic chat features',
          'Limited profile visibility',
          'Ads supported'
        ],
        limitations: [
          'Daily match limit: 3',
          'No Instagram username access',
          'Ads displayed',
          'Basic support'
        ]
      },
      {
        id: 'premium',
        name: 'Premium',
        price: 9.99,
        currency: 'USD',
        interval: 'month',
        features: [
          'Unlimited matches',
          'See Instagram usernames',
          'Ad-free experience',
          'Premium badge',
          'Priority support',
          'Advanced filters'
        ],
        popular: true
      },
      {
        id: 'premium_plus',
        name: 'Premium Plus',
        price: 19.99,
        currency: 'USD',
        interval: 'month',
        features: [
          'Everything in Premium',
          'See who liked you',
          'Boost your profile',
          'Super likes',
          'Read receipts',
          'Incognito mode'
        ]
      }
    ]

    res.json({ plans })
  } catch (error) {
    logger.error({ error }, 'Error getting subscription plans')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Create/upgrade subscription (using payment gateway)
router.post('/subscribe', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { plan_type, payment_method } = req.body

    if (!['premium', 'premium_plus'].includes(plan_type)) {
      return res.status(400).json({ error: 'Invalid plan type' })
    }

    // Create customer in payment gateway
    const customer = await PaymentGateway.createCustomer(
      req.user!.email,
      req.user!.username
    )

    // Get plan pricing
    const planPrices = {
      premium: 999, // $9.99 in cents
      premium_plus: 1999 // $19.99 in cents
    }
    const amount = planPrices[plan_type as keyof typeof planPrices]

    // Create payment intent
    const paymentIntent = await PaymentGateway.createPaymentIntent(
      amount,
      'USD',
      {
        user_id: userId,
        plan_type,
        type: 'subscription'
      }
    )

    // Use provided payment method or default test method
    const testPaymentMethod = payment_method || {
      id: 'pm_test_card',
      type: 'card',
      last4: '4242',
      brand: 'visa',
      exp_month: 12,
      exp_year: 2025
    }

    // Confirm payment
    const confirmedIntent = await PaymentGateway.confirmPaymentIntent(
      paymentIntent.id,
      testPaymentMethod
    )

    if (confirmedIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        error: 'Payment failed',
        status: confirmedIntent.status
      })
    }

    // Create subscription in payment gateway
    const paymentSubscription = await PaymentGateway.createSubscription(
      customer.id,
      plan_type,
      testPaymentMethod
    )

    // Calculate expiry date (30 days from now)
    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + 30)

    // Create subscription in our system
    const subscription = await SubscriptionService.createSubscription(
      userId,
      plan_type as 'premium' | 'premium_plus',
      expiresAt,
      'dummy_gateway',
      paymentSubscription.id,
      amount / 100, // Convert back to dollars
      'USD'
    )

    // Send subscription confirmation email
    console.log('📧 Attempting to send subscription confirmation email...')
    console.log('📧 Email details:', {
      email: req.user!.email,
      username: req.user!.username,
      planType: plan_type,
      amount: amount / 100
    })
    
    try {
      const emailResult = await EmailService.sendSubscriptionConfirmationEmail(
        req.user!.email,
        req.user!.username || 'User',
        plan_type,
        amount / 100, // Convert back to dollars
        'USD',
        expiresAt.toISOString()
      )
      
      console.log('📧 Email service result:', emailResult)
      
      if (emailResult) {
        logger.info({ 
          userId, 
          email: req.user!.email,
          planType: plan_type
        }, 'Subscription confirmation email sent successfully')
      } else {
        logger.warn({ 
          userId, 
          email: req.user!.email,
          planType: plan_type
        }, 'Email service returned false - email may not have been sent')
      }
    } catch (emailError) {
      console.error('📧 Email error:', emailError)
      logger.error({ 
        error: emailError,
        userId,
        planType: plan_type
      }, 'Failed to send subscription confirmation email')
      // Don't fail the subscription if email fails
    }

    logger.info({ userId, plan_type, paymentSubscriptionId: paymentSubscription.id }, 'User subscribed to premium')

    res.json({
      success: true,
      subscription,
      payment_subscription: paymentSubscription,
      payment_intent: {
        id: confirmedIntent.id,
        status: confirmedIntent.status
      },
      message: 'Successfully subscribed to premium!'
    })
  } catch (error) {
    logger.error({ error }, 'Error creating subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Cancel subscription
router.post('/cancel', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    await SubscriptionService.cancelSubscription(userId)

    logger.info({ userId }, 'User cancelled subscription')

    res.json({
      success: true,
      message: 'Subscription cancelled successfully'
    })
  } catch (error) {
    logger.error({ error }, 'Error cancelling subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get match limit status
router.get('/match-limit', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const matchLimit = await SubscriptionService.checkDailyMatchLimit(userId)
    const isPremium = await SubscriptionService.isPremiumUser(userId)

    res.json({
      ...matchLimit,
      is_premium: isPremium,
      message: isPremium 
        ? 'Unlimited matches available' 
        : `${matchLimit.matchesUsed}/${matchLimit.limit} matches used today`
    })
  } catch (error) {
    logger.error({ error }, 'Error getting match limit')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Admin: Get subscription statistics
router.get('/admin/stats', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const stats = await SubscriptionService.getSubscriptionStats()
    res.json(stats)
  } catch (error) {
    logger.error({ error }, 'Error getting subscription stats')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Admin: Cleanup expired subscriptions
router.post('/admin/cleanup', requireAuth, async (req: AuthRequest, res) => {
  try {
    // TODO: Add admin role check
    const cleanedUp = await SubscriptionService.cleanupExpiredSubscriptions()
    res.json({ 
      success: true, 
      cleaned_up: cleanedUp,
      message: `Cleaned up ${cleanedUp} expired subscriptions`
    })
  } catch (error) {
    logger.error({ error }, 'Error cleaning up subscriptions')
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
