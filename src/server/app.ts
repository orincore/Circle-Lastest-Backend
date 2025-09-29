import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import rateLimit from 'express-rate-limit'
import pinoHttp from 'pino-http'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'
import healthRouter from './routes/health.routes.js'
import authRouter from './routes/auth.routes.js'
import storageRouter from './routes/storage.routes.js'
import matchmakingRouter from './routes/matchmaking.routes.js'
import { heartbeat } from './services/matchmaking-optimized.js'
import { monitoringService, performanceMiddleware } from './services/monitoring.js'
import chatRouter from './routes/chat.routes.js'
import friendsRouter from './routes/friends.routes.js'
import monitoringRouter from './routes/monitoring.routes.js'
import exploreRouter from './routes/explore.routes.js'
import circleStatsRouter from './routes/circle-stats.routes.js'
import socialAccountsRouter from './routes/social-accounts.routes.js'
import notificationsRouter from './routes/notifications.routes.js'

export const app = express()

app.set('trust proxy', 1)
app.set('etag', false)

// Disable HTTPS enforcement for development
if (env.NODE_ENV === 'development') {
  app.use(helmet({
    hsts: false,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }))
} else {
  app.use(helmet())
}

app.use(cors({ 
  origin: env.NODE_ENV === 'development' ? true : env.CORS_ORIGIN, 
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}))
app.use(compression())
app.use(express.json({ limit: '2mb' }))
app.use(express.urlencoded({ extended: true }))
app.use(rateLimit({ windowMs: 60_000, max: 200 }))

// Performance monitoring middleware
app.use(performanceMiddleware())

app.use('/health', healthRouter)
app.use('/auth', authRouter)
app.use('/storage', storageRouter)
app.use('/matchmaking', matchmakingRouter)
app.use('/chat', chatRouter)
app.use('/api/friends', friendsRouter)
app.use('/api/monitoring', monitoringRouter)
app.use('/api/explore', exploreRouter)
app.use('/api/circle', circleStatsRouter)
app.use('/api/social', socialAccountsRouter)
app.use('/api/notifications', notificationsRouter)

// Start monitoring service
monitoringService.startMonitoring(30000) // Every 30 seconds

// Matchmaking heartbeat (reduced frequency since we have a dedicated worker)
setInterval(() => {
  try { heartbeat() } catch {}
}, 30_000) // Reduced to 30 seconds since worker handles most processing
