/**
 * Subscription plan helpers. Pricing/product-ID catalog lives in the
 * `subscription_plans` DB table (seeded in migrations/payments_rewrite_native_iap_razorpay.sql)
 * -- this file only has pure date-math shared by the Apple/Google/Razorpay verify handlers.
 */

export type PlanId = 'monthly' | 'yearly'

export const getDurationInDays = (billingPeriod: PlanId): number => {
  return billingPeriod === 'monthly' ? 30 : 365
}

export const computeExpiryDate = (billingPeriod: PlanId, from: Date = new Date()): Date => {
  const expiresAt = new Date(from)
  expiresAt.setDate(expiresAt.getDate() + getDurationInDays(billingPeriod))
  return expiresAt
}
