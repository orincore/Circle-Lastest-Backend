import { logger } from '../config/logger.js'

export interface PaymentMethod {
  id: string
  type: 'card' | 'paypal' | 'apple_pay' | 'google_pay'
  last4?: string
  brand?: string
  exp_month?: number
  exp_year?: number
  email?: string // for PayPal
}

export interface PaymentIntent {
  id: string
  amount: number
  currency: string
  status: 'requires_payment_method' | 'requires_confirmation' | 'processing' | 'succeeded' | 'canceled' | 'failed'
  client_secret: string
  payment_method?: PaymentMethod
  metadata?: Record<string, string>
  created_at: Date
}

export interface SubscriptionPayment {
  id: string
  customer_id: string
  plan_id: string
  status: 'active' | 'canceled' | 'past_due' | 'unpaid'
  current_period_start: Date
  current_period_end: Date
  cancel_at_period_end: boolean
  payment_method?: PaymentMethod
}

export class DummyPaymentGateway {
  private static paymentIntents: Map<string, PaymentIntent> = new Map()
  private static subscriptions: Map<string, SubscriptionPayment> = new Map()
  private static customers: Map<string, { id: string; email: string; name?: string }> = new Map()

  // Create a customer
  static async createCustomer(email: string, name?: string): Promise<{ id: string; email: string; name?: string }> {
    const customerId = `cus_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const customer = { id: customerId, email, name }
    this.customers.set(customerId, customer)
    
    logger.info({ customerId, email }, 'Dummy payment gateway: Created customer')
    return customer
  }

  // Create a payment intent
  static async createPaymentIntent(
    amount: number,
    currency: string = 'USD',
    metadata?: Record<string, string>
  ): Promise<PaymentIntent> {
    const intentId = `pi_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const clientSecret = `${intentId}_secret_${Math.random().toString(36).substr(2, 16)}`
    
    const paymentIntent: PaymentIntent = {
      id: intentId,
      amount,
      currency,
      status: 'requires_payment_method',
      client_secret: clientSecret,
      metadata,
      created_at: new Date()
    }
    
    this.paymentIntents.set(intentId, paymentIntent)
    
    logger.info({ intentId, amount, currency }, 'Dummy payment gateway: Created payment intent')
    return paymentIntent
  }

  // Confirm a payment intent (simulate payment processing)
  static async confirmPaymentIntent(
    paymentIntentId: string,
    paymentMethod: Partial<PaymentMethod>
  ): Promise<PaymentIntent> {
    const intent = this.paymentIntents.get(paymentIntentId)
    if (!intent) {
      throw new Error('Payment intent not found')
    }

    // Simulate payment processing delay
    await new Promise(resolve => setTimeout(resolve, 1000))

    // Simulate success/failure (90% success rate)
    const isSuccess = Math.random() > 0.1

    if (isSuccess) {
      intent.status = 'succeeded'
      intent.payment_method = {
        id: `pm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: paymentMethod.type || 'card',
        last4: paymentMethod.last4 || '4242',
        brand: paymentMethod.brand || 'visa',
        exp_month: paymentMethod.exp_month || 12,
        exp_year: paymentMethod.exp_year || 2025,
        email: paymentMethod.email
      }
    } else {
      intent.status = 'failed'
    }

    this.paymentIntents.set(paymentIntentId, intent)
    
    logger.info({ 
      paymentIntentId, 
      status: intent.status,
      amount: intent.amount 
    }, 'Dummy payment gateway: Confirmed payment intent')
    
    return intent
  }

  // Create a subscription
  static async createSubscription(
    customerId: string,
    planId: string,
    paymentMethod: PaymentMethod
  ): Promise<SubscriptionPayment> {
    const subscriptionId = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    const now = new Date()
    const nextMonth = new Date(now)
    nextMonth.setMonth(nextMonth.getMonth() + 1)
    
    const subscription: SubscriptionPayment = {
      id: subscriptionId,
      customer_id: customerId,
      plan_id: planId,
      status: 'active',
      current_period_start: now,
      current_period_end: nextMonth,
      cancel_at_period_end: false,
      payment_method: paymentMethod
    }
    
    this.subscriptions.set(subscriptionId, subscription)
    
    logger.info({ 
      subscriptionId, 
      customerId, 
      planId 
    }, 'Dummy payment gateway: Created subscription')
    
    return subscription
  }

  // Cancel a subscription
  static async cancelSubscription(subscriptionId: string, cancelAtPeriodEnd: boolean = true): Promise<SubscriptionPayment> {
    const subscription = this.subscriptions.get(subscriptionId)
    if (!subscription) {
      throw new Error('Subscription not found')
    }

    if (cancelAtPeriodEnd) {
      subscription.cancel_at_period_end = true
    } else {
      subscription.status = 'canceled'
    }

    this.subscriptions.set(subscriptionId, subscription)
    
    logger.info({ 
      subscriptionId, 
      cancelAtPeriodEnd,
      status: subscription.status 
    }, 'Dummy payment gateway: Canceled subscription')
    
    return subscription
  }

  // Get subscription
  static async getSubscription(subscriptionId: string): Promise<SubscriptionPayment | null> {
    return this.subscriptions.get(subscriptionId) || null
  }

  // Process webhook (simulate webhook events)
  static async processWebhook(event: {
    type: string
    data: {
      object: any
    }
  }): Promise<void> {
    logger.info({ eventType: event.type }, 'Dummy payment gateway: Processing webhook')
    
    switch (event.type) {
      case 'payment_intent.succeeded':
        // Handle successful payment
        break
      case 'payment_intent.payment_failed':
        // Handle failed payment
        break
      case 'invoice.payment_succeeded':
        // Handle successful subscription payment
        break
      case 'invoice.payment_failed':
        // Handle failed subscription payment
        break
      case 'customer.subscription.deleted':
        // Handle subscription cancellation
        break
      default:
        logger.warn({ eventType: event.type }, 'Unhandled webhook event type')
    }
  }

  // Get all payment methods for testing
  static getTestPaymentMethods(): PaymentMethod[] {
    return [
      {
        id: 'pm_test_visa',
        type: 'card',
        last4: '4242',
        brand: 'visa',
        exp_month: 12,
        exp_year: 2025
      },
      {
        id: 'pm_test_mastercard',
        type: 'card',
        last4: '4444',
        brand: 'mastercard',
        exp_month: 10,
        exp_year: 2026
      },
      {
        id: 'pm_test_paypal',
        type: 'paypal',
        email: 'test@example.com'
      },
      {
        id: 'pm_test_apple_pay',
        type: 'apple_pay',
        last4: '1234',
        brand: 'visa'
      },
      {
        id: 'pm_test_google_pay',
        type: 'google_pay',
        last4: '5678',
        brand: 'mastercard'
      }
    ]
  }

  // Simulate different payment scenarios for testing
  static async simulatePaymentScenario(scenario: 'success' | 'decline' | 'insufficient_funds' | 'network_error'): Promise<PaymentIntent> {
    const intent = await this.createPaymentIntent(999, 'USD', { scenario })
    
    switch (scenario) {
      case 'success':
        intent.status = 'succeeded'
        break
      case 'decline':
        intent.status = 'failed'
        break
      case 'insufficient_funds':
        intent.status = 'failed'
        break
      case 'network_error':
        throw new Error('Network error during payment processing')
      default:
        intent.status = 'succeeded'
    }
    
    this.paymentIntents.set(intent.id, intent)
    return intent
  }

  // Clear all test data (for testing purposes)
  static clearTestData(): void {
    this.paymentIntents.clear()
    this.subscriptions.clear()
    this.customers.clear()
    logger.info('Dummy payment gateway: Cleared all test data')
  }
}

// Export for easy replacement with real payment providers
export const PaymentGateway = DummyPaymentGateway

// Types for real payment provider integration
export interface RealPaymentProvider {
  createCustomer(email: string, name?: string): Promise<{ id: string; email: string; name?: string }>
  createPaymentIntent(amount: number, currency?: string, metadata?: Record<string, string>): Promise<PaymentIntent>
  confirmPaymentIntent(paymentIntentId: string, paymentMethod: Partial<PaymentMethod>): Promise<PaymentIntent>
  createSubscription(customerId: string, planId: string, paymentMethod: PaymentMethod): Promise<SubscriptionPayment>
  cancelSubscription(subscriptionId: string, cancelAtPeriodEnd?: boolean): Promise<SubscriptionPayment>
  getSubscription(subscriptionId: string): Promise<SubscriptionPayment | null>
  processWebhook(event: any): Promise<void>
}

// Future implementations can extend this interface:
// export class StripePaymentProvider implements RealPaymentProvider { ... }
// export class PayPalPaymentProvider implements RealPaymentProvider { ... }
// export class ApplePayProvider implements RealPaymentProvider { ... }
