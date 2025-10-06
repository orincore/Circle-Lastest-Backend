#!/usr/bin/env node

/**
 * Send retroactive sponsored subscription email for a specific subscription
 * Usage: node scripts/send-retroactive-sponsored-email.js <subscriptionId>
 * 
 * This script can be used to send sponsored emails for subscriptions that were
 * created/updated by admins before the email functionality was implemented.
 */

import { config } from 'dotenv'
import { supabase } from '../src/server/config/supabase.js'
import EmailService from '../src/server/services/emailService.js'

// Load environment variables
config()

async function sendRetroactiveSponsoredEmail(subscriptionId) {
  console.log(`🔍 Looking up subscription: ${subscriptionId}`)
  
  try {
    // Get subscription with user profile
    const { data: subscription, error } = await supabase
      .from('subscriptions')
      .select(`
        *,
        profiles!inner(email, username)
      `)
      .eq('id', subscriptionId)
      .single()
    
    if (error) {
      throw error
    }
    
    if (!subscription) {
      console.log('❌ Subscription not found')
      return false
    }
    
    const { profiles: profile } = subscription
    
    if (!profile?.email) {
      console.log('❌ No email found for user')
      return false
    }
    
    console.log(`📧 Sending sponsored subscription email to ${profile.email}`)
    console.log(`📋 Subscription details:`)
    console.log(`   - Plan: ${subscription.plan_type}`)
    console.log(`   - Status: ${subscription.status}`)
    console.log(`   - Expires: ${subscription.expires_at}`)
    console.log(`   - User: ${profile.username || 'Unknown'}`)
    
    // Send sponsored subscription email
    const emailResult = await EmailService.sendSponsoredSubscriptionEmail(
      profile.email,
      profile.username || 'User',
      subscription.plan_type,
      subscription.expires_at
    )
    
    if (emailResult) {
      console.log('✅ Sponsored subscription email sent successfully!')
      
      // Optionally mark that email was sent (add a field to track this)
      // await supabase
      //   .from('subscriptions')
      //   .update({ sponsored_email_sent: true })
      //   .eq('id', subscriptionId)
      
      return true
    } else {
      console.log('❌ Failed to send sponsored subscription email')
      return false
    }
    
  } catch (error) {
    console.error('❌ Error sending retroactive sponsored email:', error)
    return false
  }
}

async function main() {
  const subscriptionId = process.argv[2]
  
  if (!subscriptionId) {
    console.log('❌ Usage: node scripts/send-retroactive-sponsored-email.js <subscriptionId>')
    console.log('')
    console.log('📋 Example:')
    console.log('   node scripts/send-retroactive-sponsored-email.js 176e12ba-83a8-45a3-bad3-47a60798fe3b')
    process.exit(1)
  }
  
  console.log('🚀 Sending retroactive sponsored subscription email...\n')
  
  const success = await sendRetroactiveSponsoredEmail(subscriptionId)
  
  if (success) {
    console.log('\n✨ Retroactive sponsored email sent successfully!')
  } else {
    console.log('\n❌ Failed to send retroactive sponsored email')
    process.exit(1)
  }
}

// Run the script
main().catch(console.error)
