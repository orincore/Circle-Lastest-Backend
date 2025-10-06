#!/usr/bin/env node

/**
 * Simple email test to verify SMTP connection
 * Usage: node scripts/test-email-simple.js
 */

import { config } from 'dotenv'
import EmailService from '../src/server/services/emailService.js'

// Load environment variables
config()

async function testEmailConnection() {
  console.log('🧪 Testing email service connection...\n')
  
  try {
    console.log('📧 Attempting to send test subscription confirmation email...')
    
    const result = await EmailService.sendSubscriptionConfirmationEmail(
      'test@example.com',
      'Test User',
      'premium',
      9.99,
      'USD',
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    )
    
    console.log('📧 Test result:', result)
    
    if (result) {
      console.log('✅ Email service is working correctly!')
    } else {
      console.log('❌ Email service returned false - check SMTP configuration')
    }
    
  } catch (error) {
    console.error('❌ Email test failed:', error)
    console.error('Error details:', {
      message: error?.message,
      code: error?.code,
      command: error?.command
    })
  }
}

testEmailConnection().then(() => {
  console.log('\n🏁 Email test completed')
  process.exit(0)
}).catch(console.error)
