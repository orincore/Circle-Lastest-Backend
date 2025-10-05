import { Router } from 'express'
import { supabase } from '../config/supabase.js'
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
    const { data: existingUser } = await supabase
      .from('profiles')
      .select('email, email_verified')
      .eq('email', email)
      .single()

    if (existingUser?.email_verified) {
      return res.status(400).json({ 
        error: 'Email is already verified and registered' 
      })
    }

    // Check rate limiting for this email
    const { data: canResend } = await supabase
      .rpc('can_resend_otp', { user_email: email })

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
    const { data: otpStatus } = await supabase
      .rpc('get_otp_status', { user_email: email })

    return res.json({
      success: true,
      message: 'Verification code sent to your email',
      expiresInMinutes: 10,
      timeRemaining: otpStatus?.[0]?.time_remaining_minutes || 10,
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
    const { data: userProfile } = await supabase
      .from('profiles')
      .select('id, email, first_name')
      .eq('email', email)
      .single()

    let welcomeEmailSent = false
    if (userProfile) {
      // Send welcome email
      welcomeEmailSent = await emailService.sendWelcomeEmail(
        email, 
        userProfile.first_name || 'there'
      )
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
    const { data: otpStatus } = await supabase
      .rpc('get_otp_status', { user_email: email })

    const status = otpStatus?.[0] || {
      has_otp: false,
      is_verified: false,
      is_expired: false,
      attempts_count: 0,
      time_remaining_minutes: 0,
    }

    // Check if email is already verified in profiles
    const { data: profile } = await supabase
      .from('profiles')
      .select('email_verified')
      .eq('email', email)
      .single()

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
    const { data: canResend } = await supabase
      .rpc('can_resend_otp', { user_email: email })

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
    const { data: existingUser } = await supabase
      .from('profiles')
      .select('email, email_verified')
      .eq('email', email)
      .single()

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
