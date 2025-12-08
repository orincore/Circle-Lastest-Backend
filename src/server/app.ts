import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import compression from 'compression'
import rateLimit from 'express-rate-limit'
import pinoHttp from 'pino-http'
import path from 'path'
import { fileURLToPath } from 'url'
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
import careersRouter from './routes/careers.routes.js'
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
import contactRouter from './routes/contact.routes.js'
import adminRouter from './routes/admin.routes.js'
import adminUsersRouter from './routes/admin-users.routes.js'
import adminReportsRouter from './routes/admin-reports.routes.js'
import adminAnalyticsRouter from './routes/admin-analytics.routes.js'
import emailVerificationRouter from './routes/email-verification.routes.js'
import passwordResetRouter from './routes/password-reset.routes.js'
import analyticsRouter from './routes/analytics.routes.js'
import reportsRouter from './routes/reports.routes.js'
import campaignsRouter from './routes/campaigns.routes.js'
import templatesRouter from './routes/templates.routes.js'
import userAnalyticsRouter from './routes/user-analytics.routes.js'
import uploadRouter from './routes/upload.routes.js'
import adminSettingsRouter from './routes/admin-settings.routes.js'
import adminSubscriptionRouter from './routes/admin.subscription.routes.js'
import subscriptionRouter from './routes/subscription.routes.js'
import paymentRouter from './routes/payment.routes.js'
import refundRouter from './routes/refund.routes.js'
import revenueRouter from './routes/revenue.routes.js'
import aiSupportRouter from './routes/ai-support.routes.js'
import aiAdminRouter from './routes/ai-admin.routes.js'
import publicStatsRouter from './routes/public-stats.routes.js'
import userPhotosRouter from './routes/user-photos.routes.js'
import accountDeletionRouter from './routes/account-deletion.routes.js'
import referralRouter from './routes/referral.routes.js'
import adminReferralsRouter from './routes/admin-referrals.routes.js'
import verificationRouter from './routes/verification.routes.js'
import cashfreeRouter from './routes/cashfree-subscription.routes.js'
import chatListRouter from './routes/chat-list.routes.js'
import announcementsRouter from './routes/announcements.routes.js'
import adminAnnouncementsRouter from './routes/admin.announcements.routes.js'
import blindDatingRouter from './routes/blind-dating.routes.js'
import adminBlindDatingRouter from './routes/admin-blind-dating.routes.js'
import dockerMonitoringRouter from './routes/docker-monitoring.routes.js'
import appVersionRouter from './routes/app-version.routes.js'
import promptMatchingRouter from './routes/prompt-matching.routes.js'
import { setupGraphQL } from './graphql/index.js'

const app = express()

// Get directory name for ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Trust proxy for proper IP detection behind reverse proxy
app.set('trust proxy', 1)
app.set('etag', false)

// ============================================
// HEALTH CHECK - MUST BE FIRST (before any middleware)
// This allows Docker/Kubernetes health probes to work
// ============================================
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', ts: Date.now(), service: process.env.SERVICE_TYPE || 'api' })
})

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
  'http://localhost:19006', // Expo web default port
  'http://localhost:19000', // Expo dev tools
  'http://127.0.0.1:8081',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:19006',
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

// Body parsers with size limits (skip for file upload routes)
app.use((req, res, next) => {
  // Skip body parsing for file upload routes - they use multer
  if (req.path.includes('/verification/submit') || 
      req.path.includes('/upload') ||
      req.path.includes('/user-photos')) {
    return next();
  }
  express.json({ 
    limit: '2mb',
    strict: true,
  })(req, res, next);
});

app.use((req, res, next) => {
  // Skip body parsing for file upload routes
  if (req.path.includes('/verification/submit') || 
      req.path.includes('/upload') ||
      req.path.includes('/user-photos')) {
    return next();
  }
  express.urlencoded({ 
    extended: true,
    limit: '2mb',
    parameterLimit: 100,
  })(req, res, next);
});

// Input sanitization - MUST be after body parsers (skip for file uploads)
app.use((req, res, next) => {
  if (req.path.includes('/verification/submit') || 
      req.path.includes('/upload') ||
      req.path.includes('/user-photos')) {
    return next();
  }
  sanitizeInput(req, res, next);
});

// Request size validation (skip for file upload routes)
app.use((req, res, next) => {
  if (req.path.includes('/verification/submit') || 
      req.path.includes('/upload') ||
      req.path.includes('/user-photos')) {
    return next();
  }
  validateRequestSize(2 * 1024 * 1024)(req, res, next); // 2MB limit
});

// Global rate limiting (500 requests per minute per IP - increased for development)
app.use(rateLimit({ 
  windowMs: 60_000, 
  max: 500, // Increased from 200 to 500
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many failed authentication attempts. Please try again later.' },
  skip: (req) => {
    // Skip health checks and certain API endpoints that are called frequently
    return req.path === '/health' || 
           req.path.includes('/api/admin/settings') ||
           req.path.includes('/api/notifications/register-token')
  },
}))

// Performance monitoring middleware
app.use(performanceMiddleware())

// Serve static HTML files from Circle/public directory
const publicPath = path.join(__dirname, '../../../Circle/public')
app.use(express.static(publicPath))

// Specific routes for legal documents
app.get('/terms.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'terms.html'))
})

app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'privacy.html'))
})

app.get('/delete-account.html', (req, res) => {
  res.sendFile(path.join(publicPath, 'delete-account.html'))
})

// Health check is defined at the top of the file (before middleware)
app.use('/api/public', publicStatsRouter)
app.use('/api/auth', authRouter)
app.use('/api/auth', emailVerificationRouter)
app.use('/api/auth', passwordResetRouter)
app.use('/api/analytics', analyticsRouter)
app.use('/api/storage', storageRouter)
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
app.use('/api/careers', careersRouter)
app.use('/api/reports', reportsRouter)
app.use('/api/admin', adminRouter)
app.use('/api/admin/users', adminUsersRouter)
app.use('/api/admin/reports', adminReportsRouter)
app.use('/api/admin/analytics', adminAnalyticsRouter)
app.use('/api/admin/settings', adminSettingsRouter)
app.use('/api/admin/subscriptions', adminSubscriptionRouter)
app.use('/api/admin/campaigns', campaignsRouter)
app.use('/api/admin/templates', templatesRouter)
app.use('/api/analytics', userAnalyticsRouter)
app.use('/api/subscription', subscriptionRouter)
app.use('/api/payment', paymentRouter)
app.use('/api/refunds', refundRouter)
app.use('/api/revenue', revenueRouter)
app.use('/api/ai-support', aiSupportRouter)
app.use('/api/ai-admin', aiAdminRouter)
app.use('/api/users', userPhotosRouter)
app.use('/api/account', accountDeletionRouter)
app.use('/api/referrals', referralRouter)
app.use('/api/admin/referrals', adminReferralsRouter)
app.use('/api/verification', verificationRouter)
app.use('/api/cashfree', cashfreeRouter)
app.use('/api/chat-list', chatListRouter)
app.use('/api/announcements', announcementsRouter)
app.use('/api/admin/announcements', adminAnnouncementsRouter)
app.use('/api/blind-dating', blindDatingRouter)
app.use('/api/admin/blind-dating', adminBlindDatingRouter)
app.use('/api/admin/docker', dockerMonitoringRouter)
app.use('/api/app-version', appVersionRouter)
app.use('/api/upload', uploadRouter)
app.use('/api/match', promptMatchingRouter)

// GraphQL will be set up in index.ts before error handlers

// Start monitoring service
monitoringService.startMonitoring(30000) // Every 30 seconds

// Matchmaking heartbeat (reduced frequency since we have a dedicated worker)
setInterval(() => {
  try { heartbeat() } catch {}
}, 30_000) // Reduced to 30 seconds since worker handles most processing

// Error handlers will be added in index.ts after GraphQL setup

export { app }
