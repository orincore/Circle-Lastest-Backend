/**
 * Continuous Blind Dating Matcher
 * 
 * Runs every 4-5 hours (randomized) to create blind date matches for compatible users
 * This replaces the once-daily 9AM matching with more frequent opportunities
 * 
 * Usage:
 * - Run as a background service: node dist/server/workers/continuous-blind-matching.js
 * - Or via PM2/systemd for continuous operation
 */

import { logger } from '../config/logger.js'
import { BlindDatingService } from '../services/blind-dating.service.js'
import { PushNotificationService } from '../services/pushNotificationService.js'
import { supabase } from '../config/supabase.js'

// Random interval between 4-5 hours (in milliseconds)
const MIN_INTERVAL = 4 * 60 * 60 * 1000 // 4 hours
const MAX_INTERVAL = 5 * 60 * 60 * 1000 // 5 hours

function getRandomInterval(): number {
  return Math.floor(Math.random() * (MAX_INTERVAL - MIN_INTERVAL + 1)) + MIN_INTERVAL
}

async function runMatchingCycle() {
  logger.info('🎭 Starting continuous blind dating matching cycle...')
  
  const startTime = Date.now()
  
  try {
    // Use the force match function to match all eligible users
    const result = await BlindDatingService.forceMatchAllUsers()
    
    const duration = Date.now() - startTime
    
    logger.info({
      ...result,
      durationMs: duration
    }, '✅ Continuous blind dating matching cycle completed')
    
    // Send push notifications to newly matched users
    if (result.matched > 0) {
      await notifyNewMatches(result.details.filter(d => d.status === 'matched'))
    }
    
    return result
  } catch (error) {
    logger.error({ error }, '❌ Continuous blind dating matching cycle failed')
    throw error
  }
}

async function notifyNewMatches(matchedUsers: Array<{ userId: string; matchId?: string }>) {
  const matchesWithIds = matchedUsers
    .filter((match): match is { userId: string; matchId: string } => typeof match.matchId === 'string')

  if (matchesWithIds.length === 0) {
    logger.info('No matches with valid IDs to notify')
    return
  }

  logger.info({ count: matchesWithIds.length }, '📲 Sending notifications to newly matched users')
  
  for (const match of matchesWithIds) {
    try {
      await PushNotificationService.sendPushNotification(match.userId, {
        title: '💕 New Blind Date Match!',
        body: 'You have a new blind date match! Start chatting to reveal their identity.',
        data: {
          type: 'blind_date_match',
          matchId: match.matchId,
          action: 'open_blind_chat',
          screen: 'blind-dating'
        },
        sound: 'default',
        priority: 'high'
      })
    } catch (error) {
      logger.error({ error, userId: match.userId }, 'Failed to send match notification')
    }
  }
}

async function startContinuousMatching() {
  logger.info('🚀 Starting continuous blind dating matcher service')
  
  // Run initial matching cycle immediately
  await runMatchingCycle()
  
  // Schedule next cycle with random interval
  const scheduleNextCycle = () => {
    const interval = getRandomInterval()
    const hours = (interval / (60 * 60 * 1000)).toFixed(2)
    
    logger.info({ intervalMs: interval, hours }, `⏰ Next matching cycle scheduled in ${hours} hours`)
    
    setTimeout(async () => {
      await runMatchingCycle()
      scheduleNextCycle() // Schedule the next one after this completes
    }, interval)
  }
  
  scheduleNextCycle()
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startContinuousMatching()
    .catch((error) => {
      logger.error({ error }, '❌ Continuous matcher service failed to start')
      process.exit(1)
    })
}

export { startContinuousMatching, runMatchingCycle }
