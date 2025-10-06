import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'

// Admin user configuration - replace with your actual admin identifiers
const ADMIN_USERS = [
  'admin@circle.com',
  'support@circle.com',
  'orincore@gmail.com'
  // Add more admin emails or user IDs here
]

export const requireAdminAuth = async (req, res, next) => {
  try {
    // Check if user is authenticated first
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'No valid authentication token provided' 
      })
    }

    const token = authHeader.substring(7)
    
    // Verify the JWT token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token)
    
    if (error || !user) {
      return res.status(401).json({ 
        error: 'Unauthorized',
        message: 'Invalid or expired token' 
      })
    }

    // Check if user is admin
    const isAdmin = ADMIN_USERS.includes(user.email) || 
                   ADMIN_USERS.includes(user.id) ||
                   user.user_metadata?.role === 'admin' ||
                   user.app_metadata?.role === 'admin'

    if (!isAdmin) {
      logger.warn({ 
        userId: user.id, 
        email: user.email,
        path: req.path 
      }, 'Non-admin user attempted to access admin route')
      
      return res.status(403).json({ 
        error: 'Access denied',
        message: 'You do not have admin privileges to access this resource' 
      })
    }

    // Add user info to request for downstream use
    req.user = {
      id: user.id,
      email: user.email,
      role: user.user_metadata?.role || user.app_metadata?.role || 'admin'
    }

    logger.info({ 
      userId: user.id, 
      email: user.email,
      path: req.path 
    }, 'Admin user accessed protected route')

    next()
  } catch (error) {
    logger.error({ error, path: req.path }, 'Error in admin authentication middleware')
    res.status(500).json({ 
      error: 'Internal server error',
      message: 'Authentication verification failed' 
    })
  }
}

// Middleware to log admin actions
export const logAdminAction = (action) => {
  return (req, res, next) => {
    const originalSend = res.send
    
    res.send = function(data) {
      // Log the admin action
      logger.info({
        userId: req.user?.id,
        email: req.user?.email,
        action,
        path: req.path,
        method: req.method,
        body: req.method !== 'GET' ? req.body : undefined,
        success: res.statusCode < 400
      }, `Admin action: ${action}`)
      
      originalSend.call(this, data)
    }
    
    next()
  }
}

// Rate limiting for admin routes
export const adminRateLimit = (maxRequests = 100, windowMs = 15 * 60 * 1000) => {
  const requests = new Map()
  
  return (req, res, next) => {
    const userId = req.user?.id
    if (!userId) {
      return next()
    }
    
    const now = Date.now()
    const windowStart = now - windowMs
    
    // Clean old requests
    if (requests.has(userId)) {
      const userRequests = requests.get(userId).filter(time => time > windowStart)
      requests.set(userId, userRequests)
    }
    
    const userRequests = requests.get(userId) || []
    
    if (userRequests.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests',
        message: `Rate limit exceeded. Maximum ${maxRequests} requests per ${windowMs / 1000 / 60} minutes.`
      })
    }
    
    userRequests.push(now)
    requests.set(userId, userRequests)
    
    next()
  }
}

export default {
  requireAdminAuth,
  logAdminAction,
  adminRateLimit
}
