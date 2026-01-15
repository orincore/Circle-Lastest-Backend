/**
 * Inactive Blind Date Reminder Service
 * 
 * Checks for blind date matches with no messages sent and sends email reminders
 * Runs every 6 hours to check for inactive matches
 */

import { logger } from '../config/logger.js'
import { supabase } from '../config/supabase.js'
import { PushNotificationService } from '../services/pushNotificationService.js'
import EmailService from '../services/emailService.js'

const CHECK_INTERVAL = 6 * 60 * 60 * 1000 // 6 hours
const INACTIVITY_THRESHOLD = 24 * 60 * 60 * 1000 // 24 hours

interface BlindDateMatch {
  id: string
  user_a: string
  user_b: string
  message_count: number
  matched_at: string
  status: string
}

async function checkInactiveMatches() {
  logger.info('🔍 Checking for inactive blind date matches...')
  
  try {
    const twentyFourHoursAgo = new Date(Date.now() - INACTIVITY_THRESHOLD).toISOString()
    
    // Get active blind date matches with no messages that are at least 24 hours old
    const { data: inactiveMatches, error } = await supabase
      .from('blind_date_matches')
      .select('id, user_a, user_b, message_count, matched_at, status')
      .eq('status', 'active')
      .eq('message_count', 0)
      .lte('matched_at', twentyFourHoursAgo)
    
    if (error) {
      logger.error({ error }, 'Failed to fetch inactive matches')
      return
    }
    
    if (!inactiveMatches || inactiveMatches.length === 0) {
      logger.info('No inactive matches found')
      return
    }
    
    logger.info({ count: inactiveMatches.length }, 'Found inactive blind date matches')
    
    // Send reminders to both users in each match
    for (const match of inactiveMatches) {
      await sendReminders(match)
    }
    
    logger.info({ processed: inactiveMatches.length }, '✅ Completed inactive match reminder cycle')
  } catch (error) {
    logger.error({ error }, '❌ Error checking inactive matches')
  }
}

async function sendReminders(match: BlindDateMatch) {
  try {
    // Get user profiles
    const { data: users, error } = await supabase
      .from('profiles')
      .select('id, first_name, email')
      .in('id', [match.user_a, match.user_b])
    
    if (error || !users || users.length !== 2) {
      logger.error({ error, matchId: match.id }, 'Failed to fetch user profiles')
      return
    }
    
    for (const user of users) {
      // Send push notification
      await PushNotificationService.sendPushNotification(user.id, {
        title: '💬 Your Blind Date is Waiting!',
        body: 'You have an active blind date match. Start chatting to reveal their identity!',
        data: {
          type: 'blind_date_reminder',
          matchId: match.id,
          action: 'open_blind_chat',
          screen: 'blind-dating'
        },
        sound: 'default',
        priority: 'high'
      })
      
      // Send email reminder
      await EmailService.sendBlindDateReminder(
        user.email,
        user.first_name || 'there',
        match.id
      )
      
      logger.info({ userId: user.id, matchId: match.id }, 'Sent reminders to user')
    }
    
    // Update match to track that reminder was sent
    await supabase
      .from('blind_date_matches')
      .update({ 
        reminder_sent_at: new Date().toISOString() 
      })
      .eq('id', match.id)
    
  } catch (error) {
    logger.error({ error, matchId: match.id }, 'Failed to send reminders for match')
  }
}

async function startReminderService() {
  logger.info('🚀 Starting inactive blind date reminder service')
  
  // Run initial check immediately
  await checkInactiveMatches()
  
  // Schedule periodic checks
  setInterval(async () => {
    await checkInactiveMatches()
  }, CHECK_INTERVAL)
  
  logger.info({ intervalHours: CHECK_INTERVAL / (60 * 60 * 1000) }, '⏰ Reminder service running')
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startReminderService()
    .catch((error) => {
      logger.error({ error }, '❌ Reminder service failed to start')
      process.exit(1)
    })
}

export { startReminderService, checkInactiveMatches }
