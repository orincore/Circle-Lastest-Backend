/**
 * Smart Engagement Notifications Scheduler (daily features)
 *
 * Runs the three once-a-day re-engagement notification features:
 * friend-liked-a-meme (up to 3/day), birthdays, weather check-ins.
 *
 * Meme discovery is NOT run here -- its 4-8/day cadence needs a much more
 * frequent cron (every 3 hours), so it has its own dedicated scheduler:
 * see workers/meme-discovery-scheduler.ts.
 *
 * Usage:
 * - Run directly: npx ts-node src/server/workers/engagement-notifications-scheduler.ts
 * - Or via cron: 0 5 * * * cd /path/to/project && node dist/server/workers/engagement-notifications-scheduler.js
 *
 * Each feature runs in its own try/catch (one failing must not block the
 * others), and the whole pass is wrapped in a Redis distributed lock so an
 * admin-triggered run and the cron never overlap -- same pattern as
 * BlindDatingService.runMatchingPass() in blind-dating.service.ts.
 */

import { Redis } from 'ioredis'
import { logger } from '../config/logger.js'
import {
  sendFriendLikedMemeNotifications,
  sendBirthdayNotifications,
  sendWeatherCheckinNotifications,
} from '../services/engagementNotifications.service.js'

// Dedicated lock connection, same lazyConnect self-contained pattern as
// blind-dating.service.ts's lockRedis -- never opens a connection just from
// being imported.
const lockRedis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 2,
  lazyConnect: true,
})
lockRedis.on('error', (err) => {
  logger.error({ err }, 'Engagement notifications lock Redis client error')
})
const LOCK_KEY = 'engagement:notifications_lock'
const LOCK_TTL_SECONDS = 600 // whole pass (4 features, one full user scan each) gets more headroom than matching's 120s
const LOCK_OWNER_ID = `engagement-notifications-${process.pid}-${Date.now()}`

interface PassResult {
  friendLikedMeme: { processed: number; sent: number } | { error: true }
  birthdays: { selfSent: number; friendSent: number } | { error: true }
  weatherCheckin: { groupsChecked: number; usersAffected: number; sent: number } | { error: true }
}

async function runEngagementNotificationsUnlocked(): Promise<PassResult> {
  const result: PassResult = {
    friendLikedMeme: { error: true },
    birthdays: { error: true },
    weatherCheckin: { error: true },
  }

  try {
    result.friendLikedMeme = await sendFriendLikedMemeNotifications()
  } catch (error) {
    logger.error({ error }, '❌ Friend-liked-a-meme notifications failed')
  }

  try {
    result.birthdays = await sendBirthdayNotifications()
  } catch (error) {
    logger.error({ error }, '❌ Birthday notifications failed')
  }

  try {
    result.weatherCheckin = await sendWeatherCheckinNotifications()
  } catch (error) {
    logger.error({ error }, '❌ Weather check-in notifications failed')
  }

  return result
}

export async function runEngagementNotifications(): Promise<PassResult> {
  let lockAcquired = false
  try {
    const result = await lockRedis.set(LOCK_KEY, LOCK_OWNER_ID, 'EX', LOCK_TTL_SECONDS, 'NX')
    lockAcquired = result === 'OK'
  } catch (error) {
    // Redis unreachable -- fail OPEN. Every send is already deduped by the
    // engagement_notifications UNIQUE constraint, so a missed lock risks a
    // brief double-scan at worst, not a duplicate push.
    logger.error({ error }, 'Failed to acquire engagement notifications lock -- proceeding without it')
    lockAcquired = true
  }

  if (!lockAcquired) {
    logger.info('Engagement notifications pass already running elsewhere -- skipping this invocation')
    return {
      friendLikedMeme: { processed: 0, sent: 0 },
      birthdays: { selfSent: 0, friendSent: 0 },
      weatherCheckin: { groupsChecked: 0, usersAffected: 0, sent: 0 },
    }
  }

  try {
    return await runEngagementNotificationsUnlocked()
  } finally {
    try {
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
      await lockRedis.eval(script, 1, LOCK_KEY, LOCK_OWNER_ID)
    } catch (error) {
      logger.error({ error }, 'Failed to release engagement notifications lock')
    }
  }
}

async function runDailyEngagementNotifications() {
  logger.info('🔔 Starting daily engagement notifications pass...')

  const startTime = Date.now()
  const result = await runEngagementNotifications()
  const duration = Date.now() - startTime

  logger.info({ ...result, durationMs: duration }, '✅ Daily engagement notifications completed')

  console.log('\n📊 Daily Engagement Notifications Summary:')
  console.log(`   - Friend liked a meme: ${JSON.stringify(result.friendLikedMeme)}`)
  console.log(`   - Birthdays:           ${JSON.stringify(result.birthdays)}`)
  console.log(`   - Weather check-in:    ${JSON.stringify(result.weatherCheckin)}`)
  console.log(`   - Duration: ${duration}ms`)
  console.log()

  return result
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyEngagementNotifications()
    .then(() => {
      console.log('✅ Scheduler completed successfully')
      process.exit(0)
    })
    .catch((error) => {
      console.error('❌ Scheduler failed:', error)
      process.exit(1)
    })
}

export { runDailyEngagementNotifications }
