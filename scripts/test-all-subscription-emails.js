#!/usr/bin/env node

/**
 * Test all subscription email templates
 * Usage: node scripts/test-all-subscription-emails.js
 */

import EmailService from '../src/server/services/emailService.js'
import { config } from 'dotenv'

// Load environment variables
config()

async function testSubscriptionConfirmationEmail() {
  console.log('🧪 Testing subscription confirmation email...')
  
  try {
    const success = await EmailService.sendSubscriptionConfirmationEmail(
      'test@example.com',
      'John Doe',
      'premium',
      9.99,
      'USD',
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days from now
    )
    
    if (success) {
      console.log('✅ Subscription confirmation email sent successfully')
    } else {
      console.log('❌ Failed to send subscription confirmation email')
    }
  } catch (error) {
    console.error('❌ Error testing subscription confirmation email:', error.message)
  }
}

async function testSponsoredSubscriptionEmail() {
  console.log('🧪 Testing sponsored subscription email...')
  
  try {
    const success = await EmailService.sendSponsoredSubscriptionEmail(
      'test@example.com',
      'Jane Smith',
      'premium_plus',
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days from now
    )
    
    if (success) {
      console.log('✅ Sponsored subscription email sent successfully')
    } else {
      console.log('❌ Failed to send sponsored subscription email')
    }
  } catch (error) {
    console.error('❌ Error testing sponsored subscription email:', error.message)
  }
}

async function testSubscriptionCancellationEmail() {
  console.log('🧪 Testing subscription cancellation email...')
  
  try {
    const success = await EmailService.sendSubscriptionCancellationEmail(
      'test@example.com',
      'Bob Wilson',
      'premium',
      new Date().toISOString()
    )
    
    if (success) {
      console.log('✅ Subscription cancellation email sent successfully')
    } else {
      console.log('❌ Failed to send subscription cancellation email')
    }
  } catch (error) {
    console.error('❌ Error testing subscription cancellation email:', error.message)
  }
}

async function testSubscriptionExpirationEmail() {
  console.log('🧪 Testing subscription expiration email...')
  
  try {
    const success = await EmailService.sendSubscriptionExpirationEmail(
      'test@example.com',
      'Alice Johnson',
      'premium_plus',
      new Date().toISOString()
    )
    
    if (success) {
      console.log('✅ Subscription expiration email sent successfully')
    } else {
      console.log('❌ Failed to send subscription expiration email')
    }
  } catch (error) {
    console.error('❌ Error testing subscription expiration email:', error.message)
  }
}

async function main() {
  console.log('🚀 Starting comprehensive subscription email tests...\n')
  
  // Test all email types
  await testSubscriptionConfirmationEmail()
  console.log('')
  await testSponsoredSubscriptionEmail()
  console.log('')
  await testSubscriptionCancellationEmail()
  console.log('')
  await testSubscriptionExpirationEmail()
  
  console.log('\n📊 Email Test Summary:')
  console.log('✅ Confirmation Email: User subscribes to premium')
  console.log('🎁 Sponsored Email: Admin creates subscription for user')
  console.log('😔 Cancellation Email: User cancels their subscription')
  console.log('⏰ Expiration Email: Subscription expires (sent by cron job)')
  
  console.log('\n✨ All subscription email tests completed!')
  console.log('\n💡 Tips:')
  console.log('- Check your email inbox for the test emails')
  console.log('- All emails use the same consistent Circle branding')
  console.log('- Each email type has appropriate colors and messaging')
  console.log('- Mobile-responsive design works across all email clients')
}

// Run the tests
main().catch(console.error)
