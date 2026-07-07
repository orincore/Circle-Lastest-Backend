/**
 * Google Play Developer API client (subscription purchase verification).
 * Reuses the same service-account credentials already provisioned for the
 * Play Console beta-tester feature in careers.routes.ts.
 */

import { google, androidpublisher_v3 } from 'googleapis'
import { env } from './env.js'

export const isGooglePlayConfigured = (): boolean => {
  return !!(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY && env.GOOGLE_PLAY_PACKAGE_NAME)
}

let client: androidpublisher_v3.Androidpublisher | null = null

export const getAndroidPublisherClient = (): androidpublisher_v3.Androidpublisher => {
  if (!isGooglePlayConfigured()) {
    throw new Error('Google Play is not configured: set GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY, GOOGLE_PLAY_PACKAGE_NAME')
  }

  if (!client) {
    const privateKey = (env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    const jwt = new google.auth.JWT({
      email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL!,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    })
    client = google.androidpublisher({ version: 'v3', auth: jwt })
  }

  return client
}

export interface GooglePlaySubscriptionState {
  planId: string | null
  expiresAt: Date | null
  autoRenewing: boolean
  isActive: boolean
  isInGracePeriod: boolean
  orderId: string | null
  raw: androidpublisher_v3.Schema$SubscriptionPurchaseV2
}

// Always re-fetch the subscription from Google -- never trust a client- or
// notification-supplied status directly, per Play Billing's own guidance.
export const fetchGooglePlaySubscription = async (purchaseToken: string): Promise<GooglePlaySubscriptionState> => {
  const androidpublisher = getAndroidPublisherClient()

  const { data } = await androidpublisher.purchases.subscriptionsv2.get({
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME!,
    token: purchaseToken,
  })

  const lineItem = data.lineItems?.[0]
  const expiresAt = lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null
  const state = data.subscriptionState

  return {
    planId: lineItem?.productId || null,
    expiresAt,
    autoRenewing: !!lineItem?.autoRenewingPlan?.autoRenewEnabled,
    isActive: state === 'SUBSCRIPTION_STATE_ACTIVE' || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    isInGracePeriod: state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
    orderId: data.latestOrderId || null,
    raw: data,
  }
}

// Acknowledge the purchase so Google doesn't auto-refund it after 3 days
// (required exactly once per purchase token, per Play Billing docs).
export const acknowledgeGooglePlayPurchase = async (productId: string, purchaseToken: string): Promise<void> => {
  const androidpublisher = getAndroidPublisherClient()
  await androidpublisher.purchases.subscriptions.acknowledge({
    packageName: env.GOOGLE_PLAY_PACKAGE_NAME!,
    subscriptionId: productId,
    token: purchaseToken,
  })
}
