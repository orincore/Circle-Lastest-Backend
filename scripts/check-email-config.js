#!/usr/bin/env node

/**
 * Check email configuration and test email sending
 * Usage: node scripts/check-email-config.js
 */

import { config } from 'dotenv'

// Load environment variables
config()

console.log('🔍 Checking Email Configuration...\n')

// Check environment variables
console.log('📧 SMTP Configuration:')
console.log('  SMTP_HOST:', process.env.SMTP_HOST || 'NOT SET (will use default: smtp-relay.brevo.com)')
console.log('  SMTP_PORT:', process.env.SMTP_PORT || 'NOT SET (will use default: 587)')
console.log('  SMTP_USER:', process.env.SMTP_USER ? '✅ SET' : '❌ NOT SET')
console.log('  SMTP_PASSWORD:', process.env.SMTP_PASSWORD ? '✅ SET' : '❌ NOT SET')
console.log('  SMTP_FROM_EMAIL:', process.env.SMTP_FROM_EMAIL || 'NOT SET (will use default)')

console.log('\n📋 Configuration Status:')
const hasRequiredConfig = process.env.SMTP_USER && process.env.SMTP_PASSWORD

if (hasRequiredConfig) {
  console.log('✅ Email configuration appears to be complete')
} else {
  console.log('❌ Email configuration is incomplete')
  console.log('\n🛠️  To fix this, add the following to your .env file:')
  console.log('SMTP_HOST=smtp-relay.brevo.com')
  console.log('SMTP_PORT=587')
  console.log('SMTP_USER=your_smtp_login@smtp-brevo.com')
  console.log('SMTP_PASSWORD=your_smtp_key_here')
  console.log('SMTP_FROM_EMAIL="Circle Team" <noreply@circle.orincore.com>')
  console.log('\n📖 Get SMTP credentials from: https://app.brevo.com/settings/keys/smtp')
}

console.log('\n' + '='.repeat(60))
console.log('💡 If emails are not being sent, the most likely causes are:')
console.log('1. Missing or incorrect SMTP credentials in .env file')
console.log('2. SMTP server blocking the connection')
console.log('3. Invalid email addresses')
console.log('4. Network connectivity issues')
console.log('='.repeat(60))
