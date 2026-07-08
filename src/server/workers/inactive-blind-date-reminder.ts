/**
 * Inactive Blind Date Reminder Service
 * 
 * Checks for blind date matches with no messages sent and sends email reminders
 * Runs every 6 hours to check for inactive matches
 */

import { and, eq, inArray, isNull, lte } from 'drizzle-orm'
import { logger } from '../config/logger.js'
import { db } from '../config/db.js'
import { blindDateMatches, profiles } from '../db/schema.js'
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
    
    // Get active blind date matches with no messages that are at least 24 hours
    // old AND haven't already been reminded -- reminderSentAt is set after a
    // successful send specifically to make this a one-time reminder per match;
    // omitting this filter meant every invocation (every pod startup, every
    // 6h tick, across every replica) re-sent to the same matches indefinitely.
    const rows = await db.select({
      id: blindDateMatches.id,
      user_a: blindDateMatches.userA,
      user_b: blindDateMatches.userB,
      message_count: blindDateMatches.messageCount,
      matched_at: blindDateMatches.matchedAt,
      status: blindDateMatches.status,
    }).from(blindDateMatches).where(and(
      eq(blindDateMatches.status, 'active'),
      eq(blindDateMatches.messageCount, 0),
      lte(blindDateMatches.matchedAt, twentyFourHoursAgo),
      isNull(blindDateMatches.reminderSentAt),
    ))
    const inactiveMatches = rows as BlindDateMatch[]

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
    const users = await db.select({
      id: profiles.id,
      first_name: profiles.firstName,
      email: profiles.email,
    }).from(profiles).where(inArray(profiles.id, [match.user_a, match.user_b]))

    if (!users || users.length !== 2) {
      logger.error({ matchId: match.id }, 'Failed to fetch user profiles')
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
    await db.update(blindDateMatches).set({
      reminderSentAt: new Date().toISOString(),
    }).where(eq(blindDateMatches.id, match.id))

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

// This file is only ever launched as a dedicated PM2 worker entrypoint
// (never imported elsewhere), so start unconditionally. PM2 fork mode loads
// scripts through its own ProcessContainerFork wrapper, which replaces
// process.argv[1] -- the usual `import.meta.url === file://${process.argv[1]}`
// "run if main module" guard is therefore always false under PM2 and the
// service never actually started, silently exiting almost immediately on
// every restart.
startReminderService()
  .catch((error) => {
    logger.error({ error }, '❌ Reminder service failed to start')
    process.exit(1)
  })

export { startReminderService, checkInactiveMatches }
