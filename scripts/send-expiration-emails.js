#!/usr/bin/env node

/**
 * Send expiration emails for expired subscriptions
 * Usage: node scripts/send-expiration-emails.js
 * 
 * This script should be run as a cron job to check for expired subscriptions
 * and send expiration emails to users.
 */

import { config } from 'dotenv'
import { supabase } from '../src/server/config/supabase.js'
import EmailService from '../src/server/services/emailService.js'

// Load environment variables
config()

async function sendExpirationEmails() {
  
  try {
    // Get expired subscriptions that haven't been notified yet
    const { data: expiredSubscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        *,
        profiles!inner(email, username)
      `)
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString())
      .is('expiration_email_sent', false) // Only get ones that haven't been emailed yet
    
    if (error) {
      throw error
    }
    
    if (!expiredSubscriptions || expiredSubscriptions.length === 0) {
      return
    }
    
    
    let emailsSent = 0
    let emailsFailed = 0
    
    for (const subscription of expiredSubscriptions) {
      const { profiles: profile } = subscription
      
      if (!profile?.email) {
        continue
      }
      
      
      try {
        // Send expiration email
        const emailResult = await EmailService.sendSubscriptionExpirationEmail(
          profile.email,
          profile.username || 'User',
          subscription.plan_type,
          subscription.expires_at
        )
        
        if (emailResult) {
          // Mark as emailed and update status to expired
          await supabase
            .from('subscriptions')
            .update({
              status: 'expired',
              expiration_email_sent: true,
              updated_at: new Date().toISOString()
            })
            .eq('id', subscription.id)
          
          emailsSent++
        } else {
          emailsFailed++
        }
        
      } catch (emailError) {
        console.error(`❌ Error sending expiration email to ${profile.email}:`, emailError)
        emailsFailed++
      }
      
      // Add a small delay between emails to avoid overwhelming the SMTP server
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    
    
  } catch (error) {
    console.error('❌ Error checking expired subscriptions:', error)
    process.exit(1)
  }
}

async function main() {
  
  await sendExpirationEmails()
  
}

// Run the script
main().catch(console.error)
