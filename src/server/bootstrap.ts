import type { Express } from 'express'
import { app } from './app.js'
import { setupGraphQL } from './graphql/index.js'
import { notFound, errorHandler } from './middleware/errorHandler.js'
import { loadActivitiesFromDatabase } from './services/activityService.js'
import { monitoringService } from './services/monitoring.js'
import { heartbeat } from './services/matchmaking-optimized.js'
import { env } from './config/env.js'

const isServerlessRuntime = env.SERVER_RUNTIME === 'vercel' || process.env.VERCEL === '1'

let preparedAppPromise: Promise<Express> | null = null

async function initializeApp(): Promise<Express> {
  await setupGraphQL(app)
  await loadActivitiesFromDatabase()

  app.use(notFound)
  app.use(errorHandler)

  if (!isServerlessRuntime) {
    monitoringService.startMonitoring(30_000)

    setInterval(() => {
      try {
        heartbeat()
      } catch (error) {
        console.error('Heartbeat worker failed', error)
      }
    }, 30_000)
  }

  return app
}

export async function prepareApp(): Promise<Express> {
  if (!preparedAppPromise) {
    preparedAppPromise = initializeApp()
  }

  return preparedAppPromise
}
