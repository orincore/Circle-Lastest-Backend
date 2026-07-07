import express from 'express'
import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { subscriptionPlans, paymentTransactions, userSubscriptions } from '../db/schema.js'
import { SubscriptionService, checkMatchLimit } from '../services/subscription.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'
import { env } from '../config/env.js'
import { getRazorpayClient, isRazorpayConfigured, ensureRazorpayPlanId, getTotalCycles } from '../config/razorpay.js'
import { isGooglePlayConfigured, fetchGooglePlaySubscription, acknowledgeGooglePlayPurchase } from '../config/google-play.js'
import { isAppleIapConfigured, fetchAppleTransaction, verifyAppleNotification } from '../config/apple-iap.js'

const router = express.Router()

// Public: list available plans (source of truth for pricing/product IDs per store)
router.get('/plans', async (_req, res) => {
  try {
    const plans = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.isActive, true))

    res.json({
      plans: plans.map(plan => ({
        plan_id: plan.planId,
        name: plan.name,
        billing_period: plan.billingPeriod,
        price_inr: Number(plan.priceInr),
        razorpay_plan_id: plan.razorpayPlanId,
        apple_product_id: plan.appleProductId,
        google_product_id: plan.googleProductId,
        features: plan.features,
      }))
    })
  } catch (error) {
    logger.error({ error }, 'Error fetching subscription plans')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get current user's subscription status (replaces old /api/subscription/current)
router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

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
    logger.error({ error }, 'Error getting subscription status')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Daily match limit (used by the matchmaking screen to show remaining matches)
router.get('/match-limit', requireAuth, checkMatchLimit, async (req: AuthRequest, res) => {
  res.json((req as any).matchInfo)
})

// Cancel the current subscription (auto_renew off, access retained until expiry).
// Real cancellation for store purchases should still go through the platform's
// subscription management UI; this just reflects it in our records once the
// platform notifies us (or lets a web/Razorpay subscriber cancel directly).
router.post('/cancel', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const subscription = await SubscriptionService.getActiveSubscription(userId)

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' })
    }

    // iOS/Android purchases can only be cancelled by the user through the store's
    // own subscription management UI (App Store / Play Store) -- Apple explicitly
    // prohibits routing around this, and there's no reliable server-side "cancel on
    // the user's behalf" API for either platform. Only Razorpay (web) is cancelled here.
    if (subscription.source !== 'web') {
      return res.status(400).json({
        error: 'store_managed_subscription',
        message: subscription.source === 'ios'
          ? 'Manage or cancel this subscription in Settings > Apple ID > Subscriptions.'
          : 'Manage or cancel this subscription in the Play Store > Payments & subscriptions.'
      })
    }

    if (subscription.razorpay_subscription_id && isRazorpayConfigured()) {
      try {
        // cancelAtCycleEnd=true: keep access until the period already paid for ends
        await getRazorpayClient().subscriptions.cancel(subscription.razorpay_subscription_id, true)
      } catch (razorpayError) {
        logger.error({ error: razorpayError, userId }, 'Failed to cancel Razorpay subscription; cancelling locally anyway')
      }
    }

    await SubscriptionService.cancelSubscription(userId)

    res.json({
      success: true,
      message: 'Subscription cancelled. You will retain access until it expires.'
    })
  } catch (error) {
    logger.error({ error }, 'Error cancelling subscription')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// --- Razorpay (web) ---

// Create a recurring Razorpay Subscription for the chosen plan. The frontend
// opens Razorpay Checkout in subscription mode with the returned subscription_id.
router.post('/razorpay/create-subscription', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!isRazorpayConfigured()) {
      return res.status(503).json({ error: 'Razorpay is not configured' })
    }

    const userId = req.user!.id
    const { plan_id } = req.body

    if (!plan_id || !['monthly', 'yearly'].includes(plan_id)) {
      return res.status(400).json({ error: 'A valid plan_id (monthly or yearly) is required' })
    }

    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, plan_id)).limit(1)
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' })
    }

    const razorpayPlanId = await ensureRazorpayPlanId(plan_id)
    const razorpay = getRazorpayClient()

    const subscription = await razorpay.subscriptions.create({
      plan_id: razorpayPlanId,
      total_count: getTotalCycles(plan.billingPeriod),
      customer_notify: 1,
      notes: { userId, planId: plan_id },
    })

    logger.info({ userId, planId: plan_id, razorpaySubscriptionId: subscription.id }, 'Created Razorpay subscription')

    res.json({
      subscription_id: subscription.id,
      short_url: subscription.short_url,
      key_id: env.RAZORPAY_KEY_ID,
    })
  } catch (error) {
    logger.error({ error }, 'Error creating Razorpay subscription')
    res.status(500).json({ error: 'Failed to create subscription' })
  }
})

// Verify the checkout result and activate the subscription locally.
// (The webhook below is the durable source of truth for renewals/cancellations;
// this just gives the app an immediate "you're premium now" response.)
router.post('/razorpay/verify', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!isRazorpayConfigured()) {
      return res.status(503).json({ error: 'Razorpay is not configured' })
    }

    const userId = req.user!.id
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, plan_id } = req.body

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature || !plan_id) {
      return res.status(400).json({ error: 'Missing required verification fields' })
    }

    const expectedSignature = crypto
      .createHmac('sha256', env.RAZORPAY_KEY_SECRET!)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex')

    if (!crypto.timingSafeEqual(Buffer.from(razorpay_signature), Buffer.from(expectedSignature))) {
      logger.warn({ userId, razorpay_subscription_id }, 'Invalid Razorpay payment signature')
      return res.status(400).json({ error: 'Invalid payment signature' })
    }

    const razorpay = getRazorpayClient()
    const subscription = await razorpay.subscriptions.fetch(razorpay_subscription_id)
    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, plan_id)).limit(1)

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' })
    }

    const expiresAt = subscription.current_end ? new Date(subscription.current_end * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const updated = await SubscriptionService.createSubscription(
      userId,
      plan_id,
      expiresAt,
      'web',
      { razorpaySubscriptionId: subscription.id, razorpayCustomerId: subscription.customer_id || undefined },
      Number(plan.priceInr),
      'INR'
    )

    await db.insert(paymentTransactions).values({
      userId,
      subscriptionId: updated.id,
      source: 'web',
      amount: String(plan.priceInr),
      currency: 'INR',
      status: 'success',
      externalTransactionId: razorpay_payment_id,
      rawPayload: subscription as any,
    })

    logger.info({ userId, planId: plan_id, razorpaySubscriptionId: subscription.id }, 'Razorpay subscription verified and activated')

    res.json({ success: true, subscription: updated })
  } catch (error) {
    logger.error({ error }, 'Error verifying Razorpay payment')
    res.status(500).json({ error: 'Failed to verify payment' })
  }
})

// Razorpay webhook: durable source of truth for renewals/cancellations/failures.
// Signature is verified over the raw request body (populated by app.ts's express.json `verify` hook).
router.post('/razorpay/webhook', async (req, res) => {
  try {
    if (!env.RAZORPAY_WEBHOOK_SECRET) {
      logger.warn('Razorpay webhook received but RAZORPAY_WEBHOOK_SECRET is not set')
      return res.status(503).json({ error: 'Webhook not configured' })
    }

    const signature = req.headers['x-razorpay-signature'] as string
    const rawBody = (req as any).rawBody as Buffer | undefined

    if (!signature || !rawBody) {
      return res.status(400).json({ error: 'Missing signature or body' })
    }

    const expectedSignature = crypto.createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest('hex')

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      logger.warn('Invalid Razorpay webhook signature')
      return res.status(400).json({ error: 'Invalid signature' })
    }

    const event = req.body.event
    const payload = req.body.payload

    logger.info({ event }, 'Razorpay webhook received')

    switch (event) {
      case 'subscription.charged': {
        const subscriptionEntity = payload.subscription?.entity
        const paymentEntity = payload.payment?.entity
        if (!subscriptionEntity) break

        const [existing] = await db.select().from(userSubscriptions)
          .where(eq(userSubscriptions.razorpaySubscriptionId, subscriptionEntity.id))
          .limit(1)

        if (!existing) {
          logger.warn({ razorpaySubscriptionId: subscriptionEntity.id }, 'subscription.charged for unknown local subscription')
          break
        }

        const expiresAt = subscriptionEntity.current_end ? new Date(subscriptionEntity.current_end * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, existing.planId)).limit(1)

        await SubscriptionService.createSubscription(
          existing.userId,
          existing.planId as 'monthly' | 'yearly',
          expiresAt,
          'web',
          { razorpaySubscriptionId: subscriptionEntity.id, razorpayCustomerId: subscriptionEntity.customer_id || undefined },
          plan ? Number(plan.priceInr) : undefined,
          'INR'
        )

        if (paymentEntity) {
          await db.insert(paymentTransactions).values({
            userId: existing.userId,
            subscriptionId: existing.id,
            source: 'web',
            amount: String((paymentEntity.amount || 0) / 100),
            currency: paymentEntity.currency || 'INR',
            status: 'success',
            externalTransactionId: paymentEntity.id,
            rawPayload: payload,
          })
        }

        logger.info({ razorpaySubscriptionId: subscriptionEntity.id }, 'Subscription renewed via Razorpay webhook')
        break
      }

      case 'subscription.cancelled':
      case 'subscription.completed':
      case 'subscription.halted': {
        const subscriptionEntity = payload.subscription?.entity
        if (!subscriptionEntity) break

        const newStatus = event === 'subscription.halted' ? 'grace_period' : (event === 'subscription.completed' ? 'expired' : 'cancelled')

        await db.update(userSubscriptions)
          .set({ status: newStatus, updatedAt: new Date().toISOString() })
          .where(eq(userSubscriptions.razorpaySubscriptionId, subscriptionEntity.id))

        logger.info({ razorpaySubscriptionId: subscriptionEntity.id, newStatus }, 'Subscription status updated via Razorpay webhook')
        break
      }

      default:
        logger.info({ event }, 'Unhandled Razorpay webhook event')
    }

    res.json({ received: true })
  } catch (error) {
    logger.error({ error }, 'Error processing Razorpay webhook')
    res.status(500).json({ error: 'Internal server error' })
  }
})

// --- Google Play (Android) ---

// Verify a purchase token from react-native-iap right after purchase and
// activate the subscription. Always re-fetches truth from Google -- never
// trusts anything the client claims about its own purchase.
router.post('/google/verify', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!isGooglePlayConfigured()) {
      return res.status(503).json({ error: 'Google Play billing is not configured' })
    }

    const userId = req.user!.id
    const { purchase_token, product_id, plan_id } = req.body

    if (!purchase_token || !product_id || !plan_id || !['monthly', 'yearly'].includes(plan_id)) {
      return res.status(400).json({ error: 'purchase_token, product_id and a valid plan_id are required' })
    }

    const purchase = await fetchGooglePlaySubscription(purchase_token)

    if (!purchase.isActive) {
      return res.status(400).json({ error: 'This purchase is not active', state: purchase.raw.subscriptionState })
    }

    if (purchase.planId && purchase.planId !== product_id) {
      logger.warn({ userId, expected: product_id, actual: purchase.planId }, 'Google Play product_id mismatch on verify')
    }

    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, plan_id)).limit(1)
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' })
    }

    const expiresAt = purchase.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const updated = await SubscriptionService.createSubscription(
      userId,
      plan_id,
      expiresAt,
      'android',
      { googlePurchaseToken: purchase_token, googleOrderId: purchase.orderId || undefined },
      Number(plan.priceInr),
      'INR'
    )

    await db.insert(paymentTransactions).values({
      userId,
      subscriptionId: updated.id,
      source: 'android',
      amount: String(plan.priceInr),
      currency: 'INR',
      status: 'success',
      externalTransactionId: purchase.orderId || purchase_token,
      rawPayload: purchase.raw as any,
    })

    try {
      await acknowledgeGooglePlayPurchase(product_id, purchase_token)
    } catch (ackError) {
      // Non-fatal: if this purchase was already acknowledged (e.g. a retried
      // verify call), Google returns an error here but the purchase is fine.
      logger.warn({ error: ackError, userId }, 'Failed to acknowledge Google Play purchase (may already be acknowledged)')
    }

    logger.info({ userId, planId: plan_id, orderId: purchase.orderId }, 'Google Play purchase verified and activated')

    res.json({ success: true, subscription: updated })
  } catch (error) {
    logger.error({ error }, 'Error verifying Google Play purchase')
    res.status(500).json({ error: 'Failed to verify purchase' })
  }
})

// Real-Time Developer Notifications (Pub/Sub push endpoint). Google always
// wraps the actual notification in a base64-encoded `message.data` envelope;
// we only use it to know *which* purchase token to re-check, then ask Google
// for the current truth rather than trusting the notification payload.
router.post('/google/notifications', async (req, res) => {
  try {
    const message = req.body?.message
    if (!message?.data) {
      return res.status(400).json({ error: 'Missing Pub/Sub message data' })
    }

    const decoded = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'))
    const notification = decoded.subscriptionNotification
    const purchaseToken = notification?.purchaseToken

    if (!purchaseToken) {
      // Other notification types (e.g. one-time products, test notifications) -- nothing to do.
      return res.json({ received: true })
    }

    if (!isGooglePlayConfigured()) {
      logger.warn('Google Play RTDN received but Google Play billing is not configured')
      return res.status(503).json({ error: 'Not configured' })
    }

    const [existing] = await db.select().from(userSubscriptions)
      .where(eq(userSubscriptions.googlePurchaseToken, purchaseToken))
      .limit(1)

    if (!existing) {
      logger.info({ purchaseToken }, 'RTDN for a purchase token not yet linked to a local subscription (likely pending client verify call)')
      return res.json({ received: true })
    }

    const purchase = await fetchGooglePlaySubscription(purchaseToken)

    if (purchase.isActive) {
      await db.update(userSubscriptions)
        .set({
          status: purchase.isInGracePeriod ? 'grace_period' : 'active',
          expiresAt: (purchase.expiresAt || new Date()).toISOString(),
          autoRenew: purchase.autoRenewing,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(userSubscriptions.id, existing.id))
    } else {
      await db.update(userSubscriptions)
        .set({ status: 'expired', updatedAt: new Date().toISOString() })
        .where(eq(userSubscriptions.id, existing.id))
    }

    logger.info({ purchaseToken, notificationType: notification.notificationType, isActive: purchase.isActive }, 'Processed Google Play RTDN')

    res.json({ received: true })
  } catch (error) {
    logger.error({ error }, 'Error processing Google Play notification')
    // Google retries on non-2xx; still ack (200) once we've logged, to avoid
    // infinite redelivery storms for a payload we can't parse.
    res.json({ received: true, error: 'logged' })
  }
})

// --- Apple App Store (iOS) ---

// Verify a StoreKit2 transaction ID right after purchase and activate the
// subscription. Re-fetches + re-verifies the transaction from Apple itself
// rather than trusting anything the client sends beyond the transaction ID.
router.post('/apple/verify', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!isAppleIapConfigured()) {
      return res.status(503).json({ error: 'Apple IAP is not configured' })
    }

    const userId = req.user!.id
    const { transaction_id, plan_id } = req.body

    if (!transaction_id || !plan_id || !['monthly', 'yearly'].includes(plan_id)) {
      return res.status(400).json({ error: 'transaction_id and a valid plan_id are required' })
    }

    const transaction = await fetchAppleTransaction(transaction_id)

    if (!transaction.isActive) {
      return res.status(400).json({ error: 'This transaction is not an active subscription' })
    }

    const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, plan_id)).limit(1)
    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' })
    }

    if (transaction.productId && transaction.productId !== plan.appleProductId) {
      logger.warn({ userId, expected: plan.appleProductId, actual: transaction.productId }, 'Apple product_id mismatch on verify')
    }

    const expiresAt = transaction.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    const updated = await SubscriptionService.createSubscription(
      userId,
      plan_id,
      expiresAt,
      'ios',
      {
        appleOriginalTransactionId: transaction.originalTransactionId || undefined,
        appleTransactionId: transaction.transactionId || undefined,
      },
      Number(plan.priceInr),
      'INR'
    )

    await db.insert(paymentTransactions).values({
      userId,
      subscriptionId: updated.id,
      source: 'ios',
      amount: String(plan.priceInr),
      currency: 'INR',
      status: 'success',
      externalTransactionId: transaction.transactionId || transaction_id,
      rawPayload: transaction.raw as any,
    })

    logger.info({ userId, planId: plan_id, originalTransactionId: transaction.originalTransactionId }, 'Apple purchase verified and activated')

    res.json({ success: true, subscription: updated })
  } catch (error) {
    logger.error({ error }, 'Error verifying Apple purchase')
    res.status(500).json({ error: 'Failed to verify purchase' })
  }
})

// App Store Server Notifications V2 webhook -- durable source of truth for
// renewals/cancellations/refunds. Every notification is independently
// signature-verified by verifyAppleNotification (Apple's JWS chain back to
// their root CA), so this trusts nothing about the request beyond that.
router.post('/apple/notifications', async (req, res) => {
  try {
    if (!isAppleIapConfigured()) {
      logger.warn('Apple notification received but Apple IAP is not configured')
      return res.status(503).json({ error: 'Not configured' })
    }

    const { signedPayload } = req.body
    if (!signedPayload) {
      return res.status(400).json({ error: 'Missing signedPayload' })
    }

    const notification = await verifyAppleNotification(signedPayload)
    const originalTransactionId = notification.transaction?.originalTransactionId

    if (!originalTransactionId) {
      logger.info({ notificationType: notification.notificationType }, 'Apple notification with no transaction (e.g. TEST) -- nothing to do')
      return res.json({ received: true })
    }

    const [existing] = await db.select().from(userSubscriptions)
      .where(eq(userSubscriptions.appleOriginalTransactionId, originalTransactionId))
      .limit(1)

    if (!existing) {
      logger.info({ originalTransactionId }, 'Apple notification for a transaction not yet linked to a local subscription (likely pending client verify call)')
      return res.json({ received: true })
    }

    // Apple's Status enum: 1=active, 2=expired, 3=billing retry, 4=grace period, 5=revoked
    let newStatus: string
    switch (notification.status) {
      case 1: newStatus = 'active'; break
      case 4: newStatus = 'grace_period'; break
      case 5: newStatus = 'cancelled'; break
      case 2:
      case 3:
      default: newStatus = 'expired'
    }

    const updateData: Partial<typeof userSubscriptions.$inferInsert> = {
      status: newStatus,
      updatedAt: new Date().toISOString(),
    }
    if (notification.transaction?.expiresAt) {
      updateData.expiresAt = notification.transaction.expiresAt.toISOString()
    }
    if (notification.autoRenewStatus !== null) {
      updateData.autoRenew = notification.autoRenewStatus
    }

    await db.update(userSubscriptions).set(updateData).where(eq(userSubscriptions.id, existing.id))

    if (notification.notificationType === 'DID_RENEW' && notification.transaction) {
      const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, existing.planId)).limit(1)
      await db.insert(paymentTransactions).values({
        userId: existing.userId,
        subscriptionId: existing.id,
        source: 'ios',
        amount: plan ? String(plan.priceInr) : '0',
        currency: 'INR',
        status: 'success',
        externalTransactionId: notification.transaction.transactionId || undefined,
        rawPayload: notification.transaction.raw as any,
      })
    }

    logger.info({ originalTransactionId, notificationType: notification.notificationType, newStatus }, 'Processed Apple App Store notification')

    res.json({ received: true })
  } catch (error) {
    logger.error({ error }, 'Error processing Apple notification')
    res.status(500).json({ error: 'Failed to process notification' })
  }
})

export default router
