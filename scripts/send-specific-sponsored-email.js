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
      return
    }
    
    const { profiles: profile } = subscription
    
    if (!profile?.email) {
      return
    }
    
    
    
    // Send sponsored subscription email
    const emailResult = await EmailService.sendSponsoredSubscriptionEmail(
      profile.email,
      profile.username || 'User',
      subscription.plan_type,
      subscription.expires_at
    )
    
    if (emailResult) {
    } else {
    }
    
  } catch (error) {
    console.error('❌ Error sending sponsored email:', error)
  }
}

// Run the script
sendSponsoredEmailForLoggedSubscription().then(() => {
 }).catch(console.error)
