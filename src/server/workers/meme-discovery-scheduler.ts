/**
 * Meme Discovery Notifications Scheduler
 *
 * Runs the meme-discovery re-engagement feature, targeting 4-8 nudges/day
 * per recipient. That cadence needs a much more frequent cron than the
 * once-a-day pass in engagement-notifications-scheduler.ts (which handles
 * friend-liked-meme, birthdays, weather check-ins) -- this one runs every
 * 3 hours (8 slots/day), and engagementNotifications.service.ts's
 * sendMemeDiscoveryNotifications() deterministically decides per (user,
 * date) which of those 8 slots they actually get a nudge in, landing
 * everyone in the [4,8]/day range without needing any extra state here.
 *
 * Usage:
 * - Run directly: npx ts-node src/server/workers/meme-discovery-scheduler.ts
 * - Or via cron: 0 star/3 star star star cd /path/to/project && node dist/server/workers/meme-discovery-scheduler.js
 *   (see docker/crontab for the actual line)
 */

import { Redis } from 'ioredis'
import { logger } from '../config/logger.js'
import { sendMemeDiscoveryNotifications } from '../services/engagementNotifications.service.js'

// Dedicated lock connection, same lazyConnect self-contained pattern as
// blind-dating.service.ts's lockRedis -- never opens a connection just from
// being imported. Separate lock key from the daily engagement pass since
// these two schedulers run independently and must not block each other.
const lockRedis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 2,
  lazyConnect: true,
})
lockRedis.on('error', (err) => {
  logger.error({ err }, 'Meme discovery lock Redis client error')
})
const LOCK_KEY = 'engagement:meme_discovery_lock'
const LOCK_TTL_SECONDS = 300
const LOCK_OWNER_ID = `meme-discovery-${process.pid}-${Date.now()}`

async function runMemeDiscoveryPass(): Promise<{ processed: number; sent: number }> {
  const slotIndex = Math.floor(new Date().getUTCHours() / 3)

  let lockAcquired = false
  try {
    const result = await lockRedis.set(LOCK_KEY, LOCK_OWNER_ID, 'EX', LOCK_TTL_SECONDS, 'NX')
    lockAcquired = result === 'OK'
  } catch (error) {
    // Redis unreachable -- fail OPEN. Sends are still deduped by the
    // engagement_notifications UNIQUE constraint, so a missed lock risks a
    // brief double-scan at worst, not a duplicate push.
    logger.error({ error }, 'Failed to acquire meme discovery lock -- proceeding without it')
    lockAcquired = true
  }

  if (!lockAcquired) {
    logger.info('Meme discovery pass already running elsewhere -- skipping this invocation')
    return { processed: 0, sent: 0 }
  }

  try {
    return await sendMemeDiscoveryNotifications(slotIndex)
  } finally {
    try {
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
      await lockRedis.eval(script, 1, LOCK_KEY, LOCK_OWNER_ID)
    } catch (error) {
      logger.error({ error }, 'Failed to release meme discovery lock')
    }
  }
}

async function runScheduledMemeDiscovery() {
  logger.info('🔥 Starting meme discovery notifications pass...')

  const startTime = Date.now()
  const result = await runMemeDiscoveryPass()
  const duration = Date.now() - startTime

  logger.info({ ...result, durationMs: duration }, '✅ Meme discovery notifications pass completed')

  console.log('\n📊 Meme Discovery Notifications Summary:')
  console.log(`   - Processed: ${result.processed}`)
  console.log(`   - Sent:      ${result.sent}`)
  console.log(`   - Duration:  ${duration}ms`)
  console.log()

  return result
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runScheduledMemeDiscovery()
    .then(() => {
      console.log('✅ Scheduler completed successfully')
      process.exit(0)
    })
    .catch((error) => {
      console.error('❌ Scheduler failed:', error)
      process.exit(1)
    })
}

export { runScheduledMemeDiscovery, runMemeDiscoveryPass }
