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
import { heartbeat } from './services/matchmaking.js'
import chatRouter from './routes/chat.routes.js'
import friendsRouter from './routes/friends.routes.js'

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

app.use('/health', healthRouter)
app.use('/auth', authRouter)
app.use('/storage', storageRouter)
app.use('/matchmaking', matchmakingRouter)
app.use('/chat', chatRouter)
app.use('/api/friends', friendsRouter)

// housekeeping for matchmaking
setInterval(() => {
  try { heartbeat() } catch {}
}, 15_000)
