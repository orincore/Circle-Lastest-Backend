import express from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { PaymentGateway, type PaymentMethod } from '../services/payment.service.js'
import { SubscriptionService } from '../services/subscription.service.js'
import { logger } from '../config/logger.js'

const router = express.Router()

// Create payment intent for one-time payments
router.post('/create-intent', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { amount, currency = 'USD', metadata } = req.body
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' })
    }

    const paymentIntent = await PaymentGateway.createPaymentIntent(
      Math.round(amount * 100), // Convert to cents
      currency,
      {
        user_id: req.user!.id,
        ...metadata
      }
    )

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency
    })
  } catch (error) {
    logger.error({ error }, 'Error creating payment intent')
    res.status(500).json({ error: 'Failed to create payment intent' })
  }
})

// Confirm payment intent
router.post('/confirm-intent', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { payment_intent_id, payment_method } = req.body
    
    if (!payment_intent_id) {
      return res.status(400).json({ error: 'Payment intent ID is required' })
    }

    const confirmedIntent = await PaymentGateway.confirmPaymentIntent(
      payment_intent_id,
      payment_method || { type: 'card', last4: '4242', brand: 'visa' }
    )

    if (confirmedIntent.status === 'succeeded') {
      res.json({
        success: true,
        payment_intent: {
          id: confirmedIntent.id,
          status: confirmedIntent.status,
          amount: confirmedIntent.amount,
          currency: confirmedIntent.currency
        }
      })
    } else {
      res.status(400).json({
        success: false,
        error: 'Payment failed',
        status: confirmedIntent.status
      })
    }
  } catch (error) {
    logger.error({ error }, 'Error confirming payment intent')
    res.status(500).json({ error: 'Failed to confirm payment' })
  }
})

// Create customer for subscription
router.post('/create-customer', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { email, name } = req.body
    const userEmail = email || req.user!.email
    
    if (!userEmail) {
      return res.status(400).json({ error: 'Email is required' })
    }

    const customer = await PaymentGateway.createCustomer(userEmail, name)
    
    res.json({
      customer_id: customer.id,
      email: customer.email,
      name: customer.name
    })
  } catch (error) {
    logger.error({ error }, 'Error creating customer')
    res.status(500).json({ error: 'Failed to create customer' })
  }
})

// Process subscription payment
router.post('/subscribe', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { plan_type, payment_method, customer_id } = req.body
    const userId = req.user!.id
    
    if (!['premium', 'premium_plus'].includes(plan_type)) {
      return res.status(400).json({ error: 'Invalid plan type' })
    }

    // Create customer if not provided
    let customerId = customer_id
    if (!customerId) {
      const customer = await PaymentGateway.createCustomer(
        req.user!.email,
        req.user!.username
      )
      customerId = customer.id
    }

    // Get plan details
    const planPrices = {
      premium: 999, // $9.99 in cents
      premium_plus: 1999 // $19.99 in cents
    }

    const amount = planPrices[plan_type as keyof typeof planPrices]

    // Create payment intent for subscription
    const paymentIntent = await PaymentGateway.createPaymentIntent(
      amount,
      'USD',
      {
        user_id: userId,
        plan_type,
        type: 'subscription'
      }
    )

    // Simulate payment method
    const testPaymentMethod: PaymentMethod = payment_method || {
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

    if (confirmedIntent.status === 'succeeded') {
      // Check if user already has an active subscription
      const existingSubscription = await SubscriptionService.getActiveSubscription(userId)
      
      if (existingSubscription) {
        logger.info({ userId, existingPlan: existingSubscription.plan_type, newPlan: plan_type }, 'User already has subscription, updating...')
        
        // Cancel existing subscription in payment gateway if different
        if (existingSubscription.external_subscription_id) {
          try {
            await PaymentGateway.cancelSubscription(existingSubscription.external_subscription_id, false)
          } catch (cancelError) {
            logger.warn({ error: cancelError }, 'Failed to cancel existing subscription in payment gateway')
          }
        }
      }

      // Create subscription in payment gateway
      const subscription = await PaymentGateway.createSubscription(
        customerId,
        plan_type,
        testPaymentMethod
      )

      // Create or update subscription in our system
      const expiresAt = new Date()
      expiresAt.setMonth(expiresAt.getMonth() + 1)

      const userSubscription = await SubscriptionService.createSubscription(
        userId,
        plan_type as 'premium' | 'premium_plus',
        expiresAt,
        'dummy_gateway',
        subscription.id,
        amount / 100, // Convert back to dollars
        'USD'
      )

      logger.info({ userId, plan_type, subscriptionId: subscription.id }, 'Subscription created successfully')

      res.json({
        success: true,
        subscription: userSubscription,
        payment_subscription: subscription,
        message: existingSubscription 
          ? `Successfully upgraded to ${plan_type}!` 
          : `Successfully subscribed to ${plan_type}!`
      })
    } else {
      res.status(400).json({
        success: false,
        error: 'Payment failed',
        status: confirmedIntent.status
      })
    }
  } catch (error: any) {
    logger.error({ error }, 'Error processing subscription payment')
    
    // Provide more specific error messages
    if (error?.code === '23505') {
      res.status(409).json({ 
        error: 'Subscription already exists. Please try upgrading instead.',
        code: 'DUPLICATE_SUBSCRIPTION'
      })
    } else if (error?.message && error.message.includes('duplicate key')) {
      res.status(409).json({ 
        error: 'You already have an active subscription. Please contact support.',
        code: 'DUPLICATE_SUBSCRIPTION'
      })
    } else {
      res.status(500).json({ 
        error: 'Failed to process subscription. Please try again.',
        details: process.env.NODE_ENV === 'development' ? error?.message : undefined
      })
    }
  }
})

// Cancel subscription
router.post('/cancel-subscription', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { subscription_id, cancel_at_period_end = true } = req.body
    const userId = req.user!.id
    
    if (!subscription_id) {
      return res.status(400).json({ error: 'Subscription ID is required' })
    }

    // Cancel in payment gateway
    const canceledSubscription = await PaymentGateway.cancelSubscription(
      subscription_id,
      cancel_at_period_end
    )

    // Cancel in our system
    if (!cancel_at_period_end) {
      await SubscriptionService.cancelSubscription(userId)
    }

    logger.info({ userId, subscription_id, cancel_at_period_end }, 'Subscription canceled')

    res.json({
      success: true,
      subscription: canceledSubscription,
      message: cancel_at_period_end 
        ? 'Subscription will be canceled at the end of the current period'
        : 'Subscription canceled immediately'
    })
  } catch (error) {
    logger.error({ error }, 'Error canceling subscription')
    res.status(500).json({ error: 'Failed to cancel subscription' })
  }
})

// Get available payment methods (for testing)
router.get('/test-payment-methods', async (req, res) => {
  try {
    const paymentMethods = PaymentGateway.getTestPaymentMethods()
    res.json({ payment_methods: paymentMethods })
  } catch (error) {
    logger.error({ error }, 'Error getting test payment methods')
    res.status(500).json({ error: 'Failed to get payment methods' })
  }
})

// Simulate payment scenarios (for testing)
router.post('/simulate-payment', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { scenario = 'success' } = req.body
    
    const validScenarios = ['success', 'decline', 'insufficient_funds', 'network_error']
    if (!validScenarios.includes(scenario)) {
      return res.status(400).json({ error: 'Invalid scenario' })
    }

    const paymentIntent = await PaymentGateway.simulatePaymentScenario(scenario)
    
    res.json({
      payment_intent: {
        id: paymentIntent.id,
        status: paymentIntent.status,
        amount: paymentIntent.amount,
        currency: paymentIntent.currency
      },
      scenario
    })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Network error')) {
      return res.status(503).json({ error: 'Network error during payment processing' })
    }
    
    logger.error({ error }, 'Error simulating payment')
    res.status(500).json({ error: 'Failed to simulate payment' })
  }
})

// Webhook endpoint for payment provider callbacks
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    // In production, verify webhook signature here
    const event = req.body
    
    await PaymentGateway.processWebhook(event)
    
    res.json({ received: true })
  } catch (error) {
    logger.error({ error }, 'Error processing webhook')
    res.status(400).json({ error: 'Webhook processing failed' })
  }
})

// Clear test data (development only)
router.post('/clear-test-data', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Not allowed in production' })
    }
    
    PaymentGateway.clearTestData()
    res.json({ success: true, message: 'Test data cleared' })
  } catch (error) {
    logger.error({ error }, 'Error clearing test data')
    res.status(500).json({ error: 'Failed to clear test data' })
  }
})

export default router
