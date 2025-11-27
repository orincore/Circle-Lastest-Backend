/**
 * Blind Dating Daily Match Scheduler
 * 
 * This worker handles the scheduled daily matching for blind dating.
 * It should be run by a cron job every morning (e.g., 9:00 AM local time).
 * 
 * Usage:
 * - Run directly: npx ts-node src/server/workers/blind-dating-scheduler.ts
 * - Or via cron: 0 9 * * * cd /path/to/project && node dist/server/workers/blind-dating-scheduler.js
 * 
 * You can also call the admin endpoint:
 * POST /api/blind-dating/admin/process-daily-matches
 * Header: x-admin-api-key: YOUR_ADMIN_API_KEY
 */

import { logger } from '../config/logger.js'
import { BlindDatingService } from '../services/blind-dating.service.js'

async function runDailyMatching() {
  logger.info('🎭 Starting daily blind dating matching process...')
  
  const startTime = Date.now()
  
  try {
    const result = await BlindDatingService.processDailyMatches()
    
    const duration = Date.now() - startTime
    
    logger.info({
      ...result,
      durationMs: duration
    }, '✅ Daily blind dating matching completed')
    
    // Log summary
    console.log('\n📊 Daily Blind Dating Match Summary:')
    console.log(`   - Users processed: ${result.processed}`)
    console.log(`   - Matches created: ${result.matched}`)
    console.log(`   - Errors: ${result.errors}`)
    console.log(`   - Duration: ${duration}ms`)
    console.log()
    
    return result
  } catch (error) {
    logger.error({ error }, '❌ Daily blind dating matching failed')
    throw error
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runDailyMatching()
    .then(() => {
      console.log('✅ Scheduler completed successfully')
      process.exit(0)
    })
    .catch((error) => {
      console.error('❌ Scheduler failed:', error)
      process.exit(1)
    })
}

export { runDailyMatching }

