import { heartbeat } from '../services/matchmaking-optimized.js'
import { logger } from '../config/logger.js'
import Redis from 'ioredis'

// Redis client for worker coordination
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

const WORKER_ID = `matchmaking-worker-${process.pid}-${Date.now()}`
const HEARTBEAT_INTERVAL = 5000 // 5 seconds
const WORKER_TTL = 15 // 15 seconds
const LOCK_TTL = 10 // 10 seconds

class MatchmakingWorker {
  private isRunning = false
  private heartbeatTimer: NodeJS.Timeout | null = null
  private workerTimer: NodeJS.Timeout | null = null

  async start() {
    if (this.isRunning) {
      logger.warn('Matchmaking worker is already running')
      return
    }

    this.isRunning = true
    logger.info({ workerId: WORKER_ID }, 'Starting matchmaking worker')

    try {
      // Register this worker
      await this.registerWorker()

      // Start the main processing loop
      this.startProcessingLoop()

      // Start heartbeat to keep worker alive
      this.startHeartbeat()

      logger.info({ workerId: WORKER_ID }, 'Matchmaking worker started successfully')
    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Failed to start matchmaking worker')
      this.isRunning = false
      throw error
    }
  }

  async stop() {
    if (!this.isRunning) {
      return
    }

    logger.info({ workerId: WORKER_ID }, 'Stopping matchmaking worker')
    this.isRunning = false

    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }

    if (this.workerTimer) {
      clearInterval(this.workerTimer)
      this.workerTimer = null
    }

    // Unregister worker
    try {
      await redis.del(`matchmaking:workers:${WORKER_ID}`)
      logger.info({ workerId: WORKER_ID }, 'Matchmaking worker stopped')
    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Error stopping matchmaking worker')
    }
  }

  private async registerWorker() {
    try {
      await redis.setex(
        `matchmaking:workers:${WORKER_ID}`,
        WORKER_TTL,
        JSON.stringify({
          id: WORKER_ID,
          pid: process.pid,
          startedAt: Date.now(),
          lastHeartbeat: Date.now()
        })
      )
    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Failed to register worker')
      throw error
    }
  }

  private startHeartbeat() {
    this.heartbeatTimer = setInterval(async () => {
      try {
        await redis.setex(
          `matchmaking:workers:${WORKER_ID}`,
          WORKER_TTL,
          JSON.stringify({
            id: WORKER_ID,
            pid: process.pid,
            startedAt: Date.now(),
            lastHeartbeat: Date.now()
          })
        )
      } catch (error) {
        logger.error({ error, workerId: WORKER_ID }, 'Failed to send worker heartbeat')
      }
    }, HEARTBEAT_INTERVAL)
  }

  private startProcessingLoop() {
    this.workerTimer = setInterval(async () => {
      if (!this.isRunning) {
        return
      }

      try {
        // Try to acquire distributed lock for matchmaking processing
        const lockAcquired = await this.acquireLock()
        
        if (lockAcquired) {
          await this.processMatchmaking()
          await this.releaseLock()
        }
      } catch (error) {
        logger.error({ error, workerId: WORKER_ID }, 'Error in matchmaking processing loop')
      }
    }, HEARTBEAT_INTERVAL)
  }

  private async acquireLock(): Promise<boolean> {
    try {
      const result = await redis.set(
        'matchmaking:processing_lock',
        WORKER_ID,
        'PX', // milliseconds
        LOCK_TTL * 1000,
        'NX' // only if not exists
      )
      return result === 'OK'
    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Failed to acquire matchmaking lock')
      return false
    }
  }

  private async releaseLock() {
    try {
      // Only release if we own the lock
      const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `
      await redis.eval(script, 1, 'matchmaking:processing_lock', WORKER_ID)
    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Failed to release matchmaking lock')
    }
  }

  private async processMatchmaking() {
    try {
      const startTime = Date.now()
      
      // Run the matchmaking heartbeat (main processing logic)
      await heartbeat()
      
      const processingTime = Date.now() - startTime
      
      // Log performance metrics
      if (processingTime > 1000) {
        logger.warn({ 
          workerId: WORKER_ID, 
          processingTime 
        }, 'Slow matchmaking processing detected')
      } else {
        logger.debug({ 
          workerId: WORKER_ID, 
          processingTime 
        }, 'Matchmaking processing completed')
      }

      // Update processing metrics
      await redis.setex(
        `matchmaking:worker_metrics:${WORKER_ID}`,
        300, // 5 minutes TTL
        JSON.stringify({
          lastProcessed: Date.now(),
          processingTime,
          workerId: WORKER_ID
        })
      )

    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Error in matchmaking processing')
      
      // Update error metrics
      await redis.incr('matchmaking:worker_errors')
      await redis.expire('matchmaking:worker_errors', 3600) // 1 hour TTL
    }
  }

  // Get worker status and metrics
  async getStatus() {
    try {
      const workers = await this.getActiveWorkers()
      const metrics = await this.getWorkerMetrics()
      const errors = await redis.get('matchmaking:worker_errors')

      return {
        workerId: WORKER_ID,
        isRunning: this.isRunning,
        activeWorkers: workers.length,
        workers,
        metrics,
        errors: parseInt(errors || '0')
      }
    } catch (error) {
      logger.error({ error, workerId: WORKER_ID }, 'Failed to get worker status')
      return {
        workerId: WORKER_ID,
        isRunning: this.isRunning,
        activeWorkers: 0,
        workers: [],
        metrics: [],
        errors: 0
      }
    }
  }

  private async getActiveWorkers() {
    try {
      const keys = await redis.keys('matchmaking:workers:*')
      const workers = []

      for (const key of keys) {
        try {
          const data = await redis.get(key)
          if (data) {
            workers.push(JSON.parse(data))
          }
        } catch {
          // Skip invalid worker data
        }
      }

      return workers
    } catch (error) {
      logger.error({ error }, 'Failed to get active workers')
      return []
    }
  }

  private async getWorkerMetrics() {
    try {
      const keys = await redis.keys('matchmaking:worker_metrics:*')
      const metrics = []

      for (const key of keys) {
        try {
          const data = await redis.get(key)
          if (data) {
            metrics.push(JSON.parse(data))
          }
        } catch {
          // Skip invalid metrics data
        }
      }

      return metrics
    } catch (error) {
      logger.error({ error }, 'Failed to get worker metrics')
      return []
    }
  }
}

// Create and start worker
const worker = new MatchmakingWorker()

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down matchmaking worker gracefully')
  await worker.stop()
  process.exit(0)
})

process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down matchmaking worker gracefully')
  await worker.stop()
  process.exit(0)
})

// Handle uncaught exceptions
process.on('uncaughtException', async (error) => {
  logger.error({ error }, 'Uncaught exception in matchmaking worker')
  await worker.stop()
  process.exit(1)
})

process.on('unhandledRejection', async (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection in matchmaking worker')
  await worker.stop()
  process.exit(1)
})

// Start the worker
async function main() {
  try {
    await worker.start()
    
    // Keep the process alive
    process.on('exit', async () => {
      await worker.stop()
    })
    
  } catch (error) {
    logger.error({ error }, 'Failed to start matchmaking worker')
    process.exit(1)
  }
}

// Export for testing and monitoring
export { worker }

// Start if this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
