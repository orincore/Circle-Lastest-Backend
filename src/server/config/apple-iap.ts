/**
 * Apple App Store Server API client + signed-data verification (iOS in-app purchases).
 * Uses Apple's own @apple/app-store-server-library.
 */

import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { AppStoreServerAPIClient, Environment, SignedDataVerifier } from '@apple/app-store-server-library'
import type { JWSTransactionDecodedPayload, ResponseBodyV2DecodedPayload } from '@apple/app-store-server-library'
import { env } from './env.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const isAppleIapConfigured = (): boolean => {
  return !!(env.APPLE_ISSUER_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY && env.APPLE_BUNDLE_ID)
}

const appleEnvironment = process.env.NODE_ENV === 'production' ? Environment.PRODUCTION : Environment.SANDBOX

let apiClient: AppStoreServerAPIClient | null = null

export const getAppStoreServerAPIClient = (): AppStoreServerAPIClient => {
  if (!isAppleIapConfigured()) {
    throw new Error('Apple IAP is not configured: set APPLE_ISSUER_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY, APPLE_BUNDLE_ID')
  }

  if (!apiClient) {
    const signingKey = (env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    apiClient = new AppStoreServerAPIClient(
      signingKey,
      env.APPLE_KEY_ID!,
      env.APPLE_ISSUER_ID!,
      env.APPLE_BUNDLE_ID!,
      appleEnvironment
    )
  }

  return apiClient
}

let dataVerifier: SignedDataVerifier | null = null

export const getSignedDataVerifier = (): SignedDataVerifier => {
  if (!isAppleIapConfigured()) {
    throw new Error('Apple IAP is not configured')
  }

  if (!dataVerifier) {
    const rootCert = readFileSync(path.join(__dirname, 'apple-certs', 'AppleRootCA-G3.cer'))
    dataVerifier = new SignedDataVerifier(
      [rootCert],
      appleEnvironment !== Environment.SANDBOX,
      appleEnvironment,
      env.APPLE_BUNDLE_ID!
    )
  }

  return dataVerifier
}

export interface AppleTransactionState {
  productId: string | null
  originalTransactionId: string | null
  transactionId: string | null
  expiresAt: Date | null
  isActive: boolean
  raw: JWSTransactionDecodedPayload
}

function transactionToState(decoded: JWSTransactionDecodedPayload): AppleTransactionState {
  const expiresAt = decoded.expiresDate ? new Date(decoded.expiresDate) : null
  return {
    productId: decoded.productId || null,
    originalTransactionId: decoded.originalTransactionId || null,
    transactionId: decoded.transactionId || null,
    expiresAt,
    isActive: !!expiresAt && expiresAt.getTime() > Date.now() && !decoded.revocationDate,
    raw: decoded,
  }
}

// Fetch + verify a transaction from Apple by ID -- never trusts anything the
// client claims about its own purchase beyond the transaction ID itself.
export const fetchAppleTransaction = async (transactionId: string): Promise<AppleTransactionState> => {
  const client = getAppStoreServerAPIClient()
  const verifier = getSignedDataVerifier()

  const response = await client.getTransactionInfo(transactionId)
  if (!response.signedTransactionInfo) {
    throw new Error('Apple returned no signed transaction info')
  }

  const decoded = await verifier.verifyAndDecodeTransaction(response.signedTransactionInfo)
  return transactionToState(decoded)
}

export interface AppleNotification {
  notificationType: string
  subtype?: string
  transaction: AppleTransactionState | null
  autoRenewStatus: boolean | null
  // Apple's own subscription status enum for the event (1=active, 2=expired,
  // 3=billing retry, 4=billing grace period, 5=revoked) -- the most reliable
  // signal for mapping to our local status, rather than inferring from the event name.
  status: number | null
}

// Verify + decode an App Store Server Notification V2 payload.
export const verifyAppleNotification = async (signedPayload: string): Promise<AppleNotification> => {
  const verifier = getSignedDataVerifier()
  const decoded: ResponseBodyV2DecodedPayload = await verifier.verifyAndDecodeNotification(signedPayload)

  let transaction: AppleTransactionState | null = null
  if (decoded.data?.signedTransactionInfo) {
    const decodedTransaction = await verifier.verifyAndDecodeTransaction(decoded.data.signedTransactionInfo)
    transaction = transactionToState(decodedTransaction)
  }

  let autoRenewStatus: boolean | null = null
  if (decoded.data?.signedRenewalInfo) {
    const decodedRenewal = await verifier.verifyAndDecodeRenewalInfo(decoded.data.signedRenewalInfo)
    autoRenewStatus = decodedRenewal.autoRenewStatus === 1
  }

  return {
    notificationType: String(decoded.notificationType),
    subtype: decoded.subtype ? String(decoded.subtype) : undefined,
    transaction,
    autoRenewStatus,
    status: typeof decoded.data?.status === 'number' ? decoded.data.status : null,
  }
}
