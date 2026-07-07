/**
 * Razorpay client configuration (web payments) -- recurring Subscriptions,
 * not one-time Orders, so web auto-renews the same way iOS/Android do.
 */

import Razorpay from 'razorpay'
import { eq } from 'drizzle-orm'
import { env } from './env.js'
import { db } from './db.js'
import { subscriptionPlans } from '../db/schema.js'
import { logger } from './logger.js'

export const isRazorpayConfigured = (): boolean => {
  return !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
}

let client: Razorpay | null = null

export const getRazorpayClient = (): Razorpay => {
  if (!isRazorpayConfigured()) {
    throw new Error('Razorpay is not configured: set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET')
  }

  if (!client) {
    client = new Razorpay({
      key_id: env.RAZORPAY_KEY_ID!,
      key_secret: env.RAZORPAY_KEY_SECRET!,
    })
  }

  return client
}

// Razorpay's `total_count` is the max number of billing cycles a Subscription
// runs for before it auto-completes; there's no "forever" option, so these are
// long enough (10 years) that in practice a subscription only ends via cancellation.
const TOTAL_CYCLES: Record<string, number> = {
  monthly: 120,
  yearly: 10,
}

// Lazily create (once) and persist the Razorpay Plan backing one of our plan
// rows, so the only manual setup Razorpay needs is API keys -- no dashboard steps.
export const ensureRazorpayPlanId = async (planId: string): Promise<string> => {
  const [plan] = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.planId, planId)).limit(1)
  if (!plan) {
    throw new Error(`Unknown plan: ${planId}`)
  }

  if (plan.razorpayPlanId) {
    return plan.razorpayPlanId
  }

  const razorpay = getRazorpayClient()
  const created = await razorpay.plans.create({
    period: plan.billingPeriod as 'monthly' | 'yearly',
    interval: 1,
    item: {
      name: plan.name,
      amount: Math.round(Number(plan.priceInr) * 100),
      currency: 'INR',
    },
  })

  await db.update(subscriptionPlans).set({ razorpayPlanId: created.id, updatedAt: new Date().toISOString() }).where(eq(subscriptionPlans.planId, planId))
  logger.info({ planId, razorpayPlanId: created.id }, 'Created Razorpay plan')

  return created.id
}

export const getTotalCycles = (billingPeriod: string): number => TOTAL_CYCLES[billingPeriod] || 12
