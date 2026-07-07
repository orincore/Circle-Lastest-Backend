/**
 * Age Resync Worker
 *
 * profiles.date_of_birth is the source of truth for a user's age, but
 * profiles.age is kept as a plain column because several services
 * (matchmaking, compatibility scoring, explore, the Python ml-matching
 * service, admin analytics) read it directly. date_of_birth never changes,
 * but the age it implies does, once a year, on the user's birthday - this
 * worker recomputes profiles.age from date_of_birth daily so that rollover
 * happens without needing every one of those services to do date math itself.
 *
 * Usage:
 * - Run directly: npx ts-node src/server/workers/age-resync.ts
 * - Or via cron: 0 0 * * * cd /path/to/project && node dist/server/workers/age-resync.js
 */

import { sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { logger } from '../config/logger.js'

async function resyncAges() {
  logger.info('🎂 Starting daily age resync...')
  const startTime = Date.now()

  try {
    const result = await db.execute(sql`
      UPDATE profiles
      SET age = calculate_age(date_of_birth)
      WHERE date_of_birth IS NOT NULL
        AND age IS DISTINCT FROM calculate_age(date_of_birth)
    `)

    const duration = Date.now() - startTime
    const updatedCount = (result as any).rowCount ?? 0
    logger.info({ updatedCount, durationMs: duration }, '✅ Age resync completed')

    return { updatedCount, durationMs: duration }
  } catch (error) {
    logger.error({ error }, '❌ Age resync failed')
    throw error
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  resyncAges()
    .then(() => {
      console.log('✅ Age resync worker completed successfully')
      process.exit(0)
    })
    .catch((error) => {
      console.error('❌ Age resync worker failed:', error)
      process.exit(1)
    })
}

export { resyncAges }
