#!/usr/bin/env node

/**
 * Test script for subscription email functionality
 * Usage: node scripts/test-subscription-emails.js
 */

import EmailService from '../src/server/services/emailService.js'
import { config } from 'dotenv'

// Load environment variables
config()

async function testSponsoredSubscriptionEmail() {
  console.log('🧪 Testing sponsored subscription email...')
  
  try {
    const success = await EmailService.sendSponsoredSubscriptionEmail(
      'test@example.com',
      'John Doe',
      'premium',
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

async function testSubscriptionConfirmationEmail() {
  console.log('🧪 Testing subscription confirmation email...')
  
  try {
    const success = await EmailService.sendSubscriptionConfirmationEmail(
      'test@example.com',
      'Jane Smith',
      'premium_plus',
      19.99,
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

async function main() {
  console.log('🚀 Starting subscription email tests...\n')
  
  // Test both email types
  await testSponsoredSubscriptionEmail()
  console.log('')
  await testSubscriptionConfirmationEmail()
  
  console.log('\n✨ Email tests completed!')
}

// Run the tests
main().catch(console.error)
