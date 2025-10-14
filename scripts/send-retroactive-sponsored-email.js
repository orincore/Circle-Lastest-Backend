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
      return false
    }
    
    const { profiles: profile } = subscription
    
    if (!profile?.email) {
      return false
    }
    
   
    // Send sponsored subscription email
    const emailResult = await EmailService.sendSponsoredSubscriptionEmail(
      profile.email,
      profile.username || 'User',
      subscription.plan_type,
      subscription.expires_at
    )
    
    if (emailResult) {
      
      // Optionally mark that email was sent (add a field to track this)
      // await supabase
      //   .from('subscriptions')
      //   .update({ sponsored_email_sent: true })
      //   .eq('id', subscriptionId)
      
      return true
    } else {
      return false
    }
    
  } catch (error) {
    return false
  }
}

async function main() {
  const subscriptionId = process.argv[2]
  
  if (!subscriptionId) {
    process.exit(1)
  }
  
  
  const success = await sendRetroactiveSponsoredEmail(subscriptionId)
  
  if (success) {
  } else {
    process.exit(1)
  }
}

// Run the script
main().catch(console.error)
