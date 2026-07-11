// Sender aliases for transactional/marketing email, all under the
// domain-verified (SPF+DKIM) AWS SES identity notifications.orincore.com.
// SES verifies the whole domain, not individual mailboxes, so any local
// part below can send without extra per-address verification in SES.
export const EMAIL_DOMAIN = 'notifications.orincore.com'

export const EMAIL_SENDERS = {
  // OTP codes, email verification, password-reset codes
  verify: `Circle <verify@${EMAIL_DOMAIN}>`,
  // Login alerts, password-reset confirmations, other account-security notices
  security: `Circle Security <security@${EMAIL_DOMAIN}>`,
  // Welcome email, blind date match/reminder, beacon help requests -- general
  // no-reply transactional mail with no billing/support angle
  noreply: `Circle <noreply@${EMAIL_DOMAIN}>`,
  // Subscription purchase/gift/cancellation/expiration
  billing: `Circle Billing <billing@${EMAIL_DOMAIN}>`,
  // Refunds and AI/human support escalation
  support: `Circle Support <support@${EMAIL_DOMAIN}>`,
  // Bulk/admin marketing campaigns
  marketing: `Circle <marketing@${EMAIL_DOMAIN}>`,
  // Careers/job-application notifications
  careers: `Circle Careers <careers@${EMAIL_DOMAIN}>`,
} as const
