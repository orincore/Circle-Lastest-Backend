import type { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { logger } from '../config/logger.js'

/**
 * OWASP Security Middleware
 * Implements protection against OWASP Top 10 vulnerabilities
 */

// Input sanitization - prevent XSS and injection attacks
export function sanitizeInput(req: Request, res: Response, next: NextFunction) {
  try {
    // Only sanitize body for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body && typeof req.body === 'object') {
      //console.log('🔍 [Security] Before sanitization:', JSON.stringify(req.body, null, 2));
      //console.log('🔍 [Security] Username before:', req.body.username);
      req.body = sanitizeObject(req.body)
      //console.log('🔍 [Security] After sanitization:', JSON.stringify(req.body, null, 2));
      //console.log('🔍 [Security] Username after:', req.body.username);
    }

    // Sanitize query parameters (but be lenient)
    if (req.query && typeof req.query === 'object') {
      req.query = sanitizeObject(req.query)
    }

    // Sanitize URL parameters (but be lenient)
    if (req.params && typeof req.params === 'object') {
      req.params = sanitizeObject(req.params)
    }

    next()
  } catch (error) {
    logger.error({ error }, 'Error in input sanitization')
    // Continue even if sanitization fails to avoid breaking requests
    next()
  }
}

function sanitizeObject(obj: any): any {
  if (typeof obj !== 'object' || obj === null) {
    return sanitizeString(obj)
  }

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeObject(item))
  }

  const sanitized: any = {}
  for (const [key, value] of Object.entries(obj)) {
    // Sanitize key to prevent prototype pollution
    const safeKey = sanitizeString(key)
    if (key === 'username') {
      //console.log('🔍 [Security] Processing username key:', { originalKey: key, safeKey, value });
    }
    if (safeKey !== '__proto__' && safeKey !== 'constructor' && safeKey !== 'prototype') {
      sanitized[safeKey] = sanitizeObject(value)
      if (key === 'username') {
        //console.log('🔍 [Security] Username added to sanitized object:', sanitized[safeKey]);
      }
    } else if (key === 'username') {
      //console.log('🔍 [Security] Username key was BLOCKED by security filter!');
    }
  }
  return sanitized
}

function sanitizeString(value: any): any {
  if (typeof value !== 'string') return value
  
  // Remove potential XSS vectors
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '')
    .trim()
}

// Validate UUID format to prevent injection
export const uuidSchema = z.string().uuid()

export function validateUUID(value: string, fieldName: string = 'id'): boolean {
  try {
    uuidSchema.parse(value)
    return true
  } catch {
    logger.warn(`Invalid UUID format for ${fieldName}: ${value}`)
    return false
  }
}

// Rate limiting per user
const userRateLimits = new Map<string, { count: number; resetTime: number }>()

export function userRateLimit(maxRequests: number = 100, windowMs: number = 60000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).user?.id
    if (!userId) return next() // Skip for unauthenticated requests

    const now = Date.now()
    const userLimit = userRateLimits.get(userId)

    if (!userLimit || now > userLimit.resetTime) {
      userRateLimits.set(userId, { count: 1, resetTime: now + windowMs })
      return next()
    }

    if (userLimit.count >= maxRequests) {
      logger.warn(`Rate limit exceeded for user: ${userId}`)
      return res.status(429).json({ 
        error: 'Too many requests', 
        message: 'Please slow down and try again later' 
      })
    }

    userLimit.count++
    next()
  }
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now()
  for (const [userId, limit] of userRateLimits.entries()) {
    if (now > limit.resetTime) {
      userRateLimits.delete(userId)
    }
  }
}, 60000) // Clean up every minute

// Security headers middleware
export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Prevent clickjacking
  res.setHeader('X-Frame-Options', 'DENY')
  
  // Prevent MIME type sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff')
  
  // Enable XSS protection
  res.setHeader('X-XSS-Protection', '1; mode=block')
  
  // Referrer policy
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
  
  // Permissions policy
  res.setHeader('Permissions-Policy', 'geolocation=(self), microphone=(self), camera=(self)')
  
  next()
}

// Request size validation
export function validateRequestSize(maxSizeBytes: number = 2 * 1024 * 1024) {
  return (req: Request, res: Response, next: NextFunction) => {
    const contentLength = req.headers['content-length']
    if (contentLength && parseInt(contentLength) > maxSizeBytes) {
      logger.warn(`Request size exceeded: ${contentLength} bytes`)
      return res.status(413).json({ 
        error: 'Request too large', 
        message: 'Request size exceeds maximum allowed' 
      })
    }
    next()
  }
}

// Prevent parameter pollution
export function preventParameterPollution(req: Request, res: Response, next: NextFunction) {
  // Ensure query parameters are not arrays (unless expected)
  if (req.query) {
    for (const [key, value] of Object.entries(req.query)) {
      if (Array.isArray(value) && value.length > 1) {
        logger.warn(`Parameter pollution detected: ${key}`)
        req.query[key] = value[0] // Take first value only
      }
    }
  }
  next()
}

// SQL injection prevention helper
export function escapeSQL(value: string): string {
  if (typeof value !== 'string') return value
  return value.replace(/['";\\]/g, '\\$&')
}

// Validate email format
export const emailSchema = z.string().email().max(255)

// Validate common input patterns
export const schemas = {
  email: emailSchema,
  uuid: uuidSchema,
  username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_-]+$/),
  password: z.string().min(8).max(128),
  name: z.string().min(1).max(100),
  message: z.string().min(1).max(5000),
  url: z.string().url().max(2048),
  phoneNumber: z.string().regex(/^\+?[1-9]\d{1,14}$/),
}

// Audit logging for sensitive operations
export function auditLog(action: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).user?.id
    const ip = req.ip || req.socket.remoteAddress
    
    logger.info({
      action,
      userId,
      ip,
      method: req.method,
      path: req.path,
      timestamp: new Date().toISOString(),
    }, 'Security audit log')
    
    next()
  }
}

// Detect and prevent common attack patterns
export function detectAttackPatterns(req: Request, res: Response, next: NextFunction) {
  // Skip detection for safe methods and health checks
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/health') {
    return next()
  }

  const suspiciousPatterns = [
    { pattern: /<script[\s\S]*?>[\s\S]*?<\/script>/gi, name: 'XSS Script Tag' },
    { pattern: /javascript:/gi, name: 'XSS JavaScript Protocol' },
    { pattern: /on\w+\s*=\s*["'][^"']*["']/gi, name: 'XSS Event Handler' },
    { pattern: /\.\.\//g, name: 'Path Traversal' },
    { pattern: /(\%00)/i, name: 'Null Byte Injection' },
    // More lenient SQL injection detection - only block obvious attacks
    { pattern: /(\bunion\b.*\bselect\b)|(\bselect\b.*\bfrom\b.*\bwhere\b.*\bor\b.*=.*)/gi, name: 'SQL Injection' },
  ]

  const checkString = JSON.stringify({
    body: req.body,
    query: req.query,
    params: req.params,
  })

  for (const { pattern, name } of suspiciousPatterns) {
    if (pattern.test(checkString)) {
      logger.warn({
        ip: req.ip,
        path: req.path,
        method: req.method,
        pattern: name,
      }, 'Suspicious pattern detected')
      
      return res.status(400).json({ 
        error: 'Invalid request', 
        message: 'Request contains invalid characters' 
      })
    }
  }

  next()
}

// CSRF token validation (for state-changing operations)
export function validateCSRF(req: Request, res: Response, next: NextFunction) {
  // Skip for GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next()
  }

  const csrfToken = req.headers['x-csrf-token'] as string
  const sessionToken = (req as any).token

  // For now, we'll use the JWT token as CSRF protection
  // In production, implement proper CSRF tokens
  if (!sessionToken) {
    logger.warn('CSRF validation failed: No session token')
    return res.status(403).json({ 
      error: 'Forbidden', 
      message: 'CSRF validation failed' 
    })
  }

  next()
}

// Content type validation
export function validateContentType(req: Request, res: Response, next: NextFunction) {
  // Only validate content-type for requests with body
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const contentType = req.headers['content-type']
    
    // Allow requests without content-type if body is empty
    const contentLength = req.headers['content-length']
    if (!contentLength || contentLength === '0') {
      return next()
    }
    
    if (!contentType || (!contentType.includes('application/json') && !contentType.includes('multipart/form-data'))) {
      logger.warn(`Invalid content type: ${contentType} for ${req.method} ${req.path}`)
      return res.status(415).json({ 
        error: 'Unsupported Media Type', 
        message: 'Content-Type must be application/json or multipart/form-data' 
      })
    }
  }
  next()
}
