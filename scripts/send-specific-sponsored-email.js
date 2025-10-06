#!/usr/bin/env node

/**
 * Send sponsored email for the specific subscription from the logs
 * Usage: node scripts/send-specific-sponsored-email.js
 */

import { config } from 'dotenv'
import { supabase } from '../src/server/config/supabase.js'
import EmailService from '../src/server/services/emailService.js'

// Load environment variables
config()

// The subscription ID from the logs
const SUBSCRIPTION_ID = '176e12ba-83a8-45a3-bad3-47a60798fe3b'

async function sendSponsoredEmailForLoggedSubscription() {
  console.log('🚀 Sending sponsored email for subscription from logs...')
  console.log(`📋 Subscription ID: ${SUBSCRIPTION_ID}`)
  console.log('')
  
  try {
    // Get subscription with user profile
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select(`
        *,
        profiles!inner(email, username)
      `)
      .eq('id', SUBSCRIPTION_ID)
      .single()
    
    if (error) {
      throw error
    }
    
    if (!subscription) {
      console.log('❌ Subscription not found')
      return
    }
    
    const { profiles: profile } = subscription
    
    if (!profile?.email) {
      console.log('❌ No email found for user')
      return
    }
    
    console.log(`📧 Sending sponsored subscription email...`)
    console.log(`   📧 To: ${profile.email}`)
    console.log(`   👤 User: ${profile.username || 'Unknown'}`)
    console.log(`   📋 Plan: ${subscription.plan_type}`)
    console.log(`   📅 Expires: ${subscription.expires_at}`)
    console.log('')
    
    // Send sponsored subscription email
    const emailResult = await EmailService.sendSponsoredSubscriptionEmail(
      profile.email,
      profile.username || 'User',
      subscription.plan_type,
      subscription.expires_at
    )
    
    if (emailResult) {
      console.log('✅ Sponsored subscription email sent successfully!')
      console.log('')
      console.log('🎁 The user should receive an email with:')
      console.log('   - "Surprise, [Name]! 🎉" subject line')
      console.log('   - Gift notification with premium features')
      console.log('   - "Sponsored by Circle Team" branding')
      console.log('   - Same beautiful design as confirmation emails')
    } else {
      console.log('❌ Failed to send sponsored subscription email')
    }
    
  } catch (error) {
    console.error('❌ Error sending sponsored email:', error)
  }
}

// Run the script
sendSponsoredEmailForLoggedSubscription().then(() => {
  console.log('\n✨ Script completed!')
}).catch(console.error)
