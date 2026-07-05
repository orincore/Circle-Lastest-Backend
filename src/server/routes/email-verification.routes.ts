import { Router } from 'express'
import { eq, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'
import emailService from '../services/emailService.js'
import rateLimit from 'express-rate-limit'

const router = Router()

// Rate limiting for OTP requests
const otpRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 OTP requests per windowMs
  message: {
    error: 'Too many OTP requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
})

const otpVerifyLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 verification attempts per windowMs
  message: {
    error: 'Too many verification attempts from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
})

async function canResendOtp(email: string): Promise<boolean> {
  const result = await db.execute(sql`select can_resend_otp(${email}) as result`)
  return Boolean((result.rows[0] as any)?.result)
}

async function getOtpStatus(email: string) {
  const result = await db.execute(sql`select * from get_otp_status(${email})`)
  return (result.rows[0] as any) || null
}

/**
 * Send OTP for email verification
 * POST /api/auth/send-otp
 */
router.post('/send-otp', otpRequestLimit, async (req, res) => {
  try {
    const { email, name } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' })
    }

    // Check if email is already registered and verified
    const [existingUser] = await db.select({ email: profiles.email, email_verified: profiles.emailVerified }).from(profiles).where(eq(profiles.email, email)).limit(1)

    if (existingUser?.email_verified) {
      return res.status(400).json({
        error: 'Email is already verified and registered'
      })
    }

    // Check rate limiting for this email
    const canResend = await canResendOtp(email)

    if (!canResend) {
      return res.status(429).json({ 
        error: 'Please wait at least 1 minute before requesting another OTP' 
      })
    }

    // Generate and store OTP
    const otpResult = await emailService.generateAndStoreOTP(email)
    if (!otpResult.success) {
      return res.status(500).json({ error: otpResult.error })
    }

    // Send OTP email
    const emailSent = await emailService.sendOTPEmail(email, otpResult.otp!, name)
    if (!emailSent) {
      return res.status(500).json({ 
        error: 'Failed to send verification email. Please try again.' 
      })
    }

    // Get OTP status for response
    const otpStatus = await getOtpStatus(email)

    return res.json({
      success: true,
      message: 'Verification code sent to your email',
      expiresInMinutes: 10,
      timeRemaining: otpStatus?.time_remaining_minutes || 10,
    })
  } catch (error) {
    console.error('Send OTP error:', error)
    return res.status(500).json({ error: 'Failed to send verification code' })
  }
})

/**
 * Verify OTP
 * POST /api/auth/verify-otp
 */
router.post('/verify-otp', otpVerifyLimit, async (req, res) => {
  try {
    const { email, otp } = req.body

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP are required' })
    }

    // Validate OTP format (6 digits)
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ error: 'OTP must be 6 digits' })
    }

    // Verify OTP
    const verifyResult = await emailService.verifyOTP(email, otp)
    if (!verifyResult.success) {
      return res.status(400).json({ error: verifyResult.error })
    }

    // Check if user profile exists
    const [userProfile] = await db.select({ id: profiles.id, email: profiles.email, first_name: profiles.firstName }).from(profiles).where(eq(profiles.email, email)).limit(1)

    let welcomeEmailSent = false
    if (userProfile) {
      // Send comprehensive signup success email (includes welcome + additional info)
      welcomeEmailSent = await emailService.sendSignupSuccessEmail(
        email, 
        userProfile.first_name || 'User'
      )
      //console.log(`🎉 Welcome email sent to ${userProfile.first_name} (${email}) after email verification`)
    }

    return res.json({
      success: true,
      message: 'Email verified successfully',
      emailVerified: true,
      welcomeEmailSent,
    })
  } catch (error) {
    console.error('Verify OTP error:', error)
    return res.status(500).json({ error: 'Failed to verify OTP' })
  }
})

/**
 * Check OTP status
 * GET /api/auth/otp-status/:email
 */
router.get('/otp-status/:email', async (req, res) => {
  try {
    const { email } = req.params

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Get OTP status
    const otpStatus = await getOtpStatus(email)

    const status = otpStatus || {
      has_otp: false,
      is_verified: false,
      is_expired: false,
      attempts_count: 0,
      time_remaining_minutes: 0,
    }

    // Check if email is already verified in profiles
    const [profile] = await db.select({ email_verified: profiles.emailVerified }).from(profiles).where(eq(profiles.email, email)).limit(1)

    return res.json({
      hasOTP: status.has_otp,
      isVerified: status.is_verified || profile?.email_verified || false,
      isExpired: status.is_expired,
      attemptsCount: status.attempts_count,
      timeRemainingMinutes: status.time_remaining_minutes,
      canResend: status.is_expired || status.time_remaining_minutes <= 0,
      maxAttempts: 5,
    })
  } catch (error) {
    console.error('OTP status error:', error)
    return res.status(500).json({ error: 'Failed to get OTP status' })
  }
})

/**
 * Resend OTP
 * POST /api/auth/resend-otp
 */
router.post('/resend-otp', otpRequestLimit, async (req, res) => {
  try {
    const { email, name } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Check if already verified
    const isVerified = await emailService.isEmailVerified(email)
    if (isVerified) {
      return res.status(400).json({ error: 'Email is already verified' })
    }

    // Check rate limiting
    const canResend = await canResendOtp(email)

    if (!canResend) {
      return res.status(429).json({
        error: 'Please wait at least 1 minute before requesting another OTP'
      })
    }

    // Generate and store new OTP
    const otpResult = await emailService.generateAndStoreOTP(email)
    if (!otpResult.success) {
      return res.status(500).json({ error: otpResult.error })
    }

    // Send OTP email
    const emailSent = await emailService.sendOTPEmail(email, otpResult.otp!, name)
    if (!emailSent) {
      return res.status(500).json({ 
        error: 'Failed to send verification email. Please try again.' 
      })
    }

    return res.json({
      success: true,
      message: 'New verification code sent to your email',
      expiresInMinutes: 10,
    })
  } catch (error) {
    console.error('Resend OTP error:', error)
    return res.status(500).json({ error: 'Failed to resend verification code' })
  }
})

/**
 * Check if email is available for registration
 * GET /api/auth/check-email/:email
 */
router.get('/check-email/:email', async (req, res) => {
  try {
    const { email } = req.params

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    // Check if email exists in profiles
    const [existingUser] = await db.select({ email: profiles.email, email_verified: profiles.emailVerified }).from(profiles).where(eq(profiles.email, email)).limit(1)

    if (existingUser) {
      return res.json({
        available: false,
        reason: existingUser.email_verified ? 'verified' : 'pending_verification',
        message: existingUser.email_verified 
          ? 'Email is already registered and verified'
          : 'Email is registered but not verified',
      })
    }

    return res.json({
      available: true,
      message: 'Email is available for registration',
    })
  } catch (error) {
    console.error('Check email error:', error)
    return res.status(500).json({ error: 'Failed to check email availability' })
  }
})

export default router
