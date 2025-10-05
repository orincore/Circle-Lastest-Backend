import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import rateLimit from 'express-rate-limit'
import pinoHttp from 'pino-http'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { errorHandler, notFound } from './middleware/errorHandler.js'
import { 
  sanitizeInput, 
  securityHeaders, 
  validateRequestSize, 
  preventParameterPollution,
  detectAttackPatterns,
  validateContentType
} from './middleware/security.js'
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
import uploadRouter from '../routes/upload.routes.js'
import contactRouter from './routes/contact.routes.js'
import adminRouter from './routes/admin.routes.js'
import adminUsersRouter from './routes/admin-users.routes.js'
import adminReportsRouter from './routes/admin-reports.routes.js'
import adminAnalyticsRouter from './routes/admin-analytics.routes.js'
import adminSettingsRouter from './routes/admin-settings.routes.js'
import reportsRouter from './routes/reports.routes.js'
import campaignsRouter from './routes/campaigns.routes.js'
import templatesRouter from './routes/templates.routes.js'
import userAnalyticsRouter from './routes/user-analytics.routes.js'

export const app = express()

// Trust proxy for proper IP detection behind reverse proxy
app.set('trust proxy', 1)
app.set('etag', false)

// Security: Disable X-Powered-By header
app.disable('x-powered-by')

// Enhanced Helmet configuration for production security
if (env.NODE_ENV === 'development') {
  app.use(helmet({
    hsts: false,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }))
} else {
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
  }))
}

// CORS configuration with strict origin validation
const allowedOrigins = [
  'http://localhost:8081',
  'http://localhost:8080',
  'http://localhost:3000',
  'https://circle.orincore.com',
  'https://api.circle.orincore.com',
]

app.use(cors({ 
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true)
    
    // In development, allow all origins
    if (env.NODE_ENV === 'development') {
      return callback(null, true)
    }
    
    // In production, check against whitelist
    if (allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      logger.warn({ origin }, 'CORS: Origin not allowed')
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-CSRF-Token'],
  exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining'],
  maxAge: 600, // 10 minutes
}))

// Compression for response optimization
app.use(compression())

// Security middleware - MUST be before body parsers
app.use(securityHeaders)
app.use(detectAttackPatterns)
app.use(validateContentType)
app.use(preventParameterPollution)

// Body parsers with size limits
app.use(express.json({ 
  limit: '2mb',
  strict: true, // Only accept arrays and objects
}))
app.use(express.urlencoded({ 
  extended: true,
  limit: '2mb',
  parameterLimit: 100, // Limit number of parameters
}))

// Input sanitization - MUST be after body parsers
app.use(sanitizeInput)

// Request size validation
app.use(validateRequestSize(2 * 1024 * 1024)) // 2MB limit

// Global rate limiting (200 requests per minute per IP)
app.use(rateLimit({ 
  windowMs: 60_000, 
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
  skip: (req) => req.path === '/health', // Skip health checks
}))

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
app.use('/api/upload', uploadRouter)
app.use('/api/contact', contactRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/admin/users', adminUsersRouter)
app.use('/api/admin/reports', adminReportsRouter)
app.use('/api/admin/analytics', adminAnalyticsRouter)
app.use('/api/admin/settings', adminSettingsRouter)
app.use('/api/admin/campaigns', campaignsRouter)
app.use('/api/admin/templates', templatesRouter)
app.use('/api/analytics', userAnalyticsRouter)

// Start monitoring service
monitoringService.startMonitoring(30000) // Every 30 seconds

// Matchmaking heartbeat (reduced frequency since we have a dedicated worker)
setInterval(() => {
  try { heartbeat() } catch {}
}, 30_000) // Reduced to 30 seconds since worker handles most processing
