import { Router } from 'express'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { emailOtps, profiles } from '../db/schema.js'
import emailService from '../services/emailService.js'
import rateLimit from 'express-rate-limit'
import bcrypt from 'bcryptjs'
import { z } from 'zod'

const router = Router()

// Rate limiting for password reset requests
const resetRequestLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30, // Limit each IP to 30 reset requests per windowMs (increased for development/testing)
  message: {
    error: 'Too many password reset requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
})

const resetVerifyLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 verification attempts per windowMs (increased for development/testing)
  message: {
    error: 'Too many reset verification attempts from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
})

// Validation schemas
const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email format'),
})

const verifyResetOtpSchema = z.object({
  email: z.string().email('Invalid email format'),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
})

const resetPasswordSchema = z.object({
  email: z.string().email('Invalid email format'),
  resetToken: z.string().min(6, 'Invalid reset token'),
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
})

/**
 * Send password reset OTP
 * POST /api/auth/forgot-password
 */
router.post('/forgot-password', resetRequestLimit, async (req, res) => {
  try {
    const parse = forgotPasswordSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ 
        error: 'Invalid input', 
        details: parse.error.flatten() 
      })
    }

    const { email } = parse.data

    // Check if user exists
    const [user] = await db.select({ id: profiles.id, email: profiles.email, first_name: profiles.firstName }).from(profiles).where(eq(profiles.email, email)).limit(1)

    if (!user) {
      // Don't reveal if email exists or not for security
      return res.json({
        success: true,
        message: 'If an account with this email exists, you will receive a password reset code.',
      })
    }

    // Check rate limiting for this email
    const canResendResult = await db.execute(sql`select can_resend_otp(${email}) as result`)
    const canResend = Boolean((canResendResult.rows[0] as any)?.result)

    if (!canResend) {
      return res.status(429).json({ 
        error: 'Please wait at least 1 minute before requesting another reset code' 
      })
    }

    // Generate and store OTP for password reset
    const otpResult = await emailService.generateAndStoreOTP(email)
    if (!otpResult.success) {
      return res.status(500).json({ error: otpResult.error })
    }

    // Send password reset email
    const emailSent = await emailService.sendPasswordResetEmail(
      email, 
      otpResult.otp!, 
      user.first_name || 'User'
    )
    
    if (!emailSent) {
      return res.status(500).json({ 
        error: 'Failed to send password reset email. Please try again.' 
      })
    }

    return res.json({
      success: true,
      message: 'Password reset code sent to your email',
      expiresInMinutes: 10,
    })
  } catch (error) {
    console.error('Forgot password error:', error)
    return res.status(500).json({ error: 'Failed to process password reset request' })
  }
})

/**
 * Verify password reset OTP
 * POST /api/auth/verify-reset-otp
 */
router.post('/verify-reset-otp', resetVerifyLimit, async (req, res) => {
  try {
    const parse = verifyResetOtpSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ 
        error: 'Invalid input', 
        details: parse.error.flatten() 
      })
    }

    const { email, otp } = parse.data

    // Verify OTP
    //console.log('🔍 Verifying reset OTP:', { email, otp })
    const verifyResult = await emailService.verifyOTP(email, otp)
    //console.log('🔍 OTP verification result:', verifyResult)
    
    if (!verifyResult.success) {
      return res.status(400).json({ error: verifyResult.error })
    }

    // Double-check that the OTP is marked as verified in the database
    const [verifiedRecord] = await db.select().from(emailOtps).where(and(
      eq(emailOtps.email, email),
      eq(emailOtps.otp, otp),
      eq(emailOtps.verified, true),
    )).limit(1)

    //console.log('🔍 Verified record in database:', verifiedRecord)

    return res.json({
      success: true,
      message: 'Reset code verified successfully',
      resetToken: otp, // Use OTP as temporary reset token
    })
  } catch (error) {
    console.error('Verify reset OTP error:', error)
    return res.status(500).json({ error: 'Failed to verify reset code' })
  }
})

/**
 * Reset password with verified token
 * POST /api/auth/reset-password
 */
router.post('/reset-password', async (req, res) => {
  try {
    const parse = resetPasswordSchema.safeParse(req.body)
    if (!parse.success) {
      return res.status(400).json({ 
        error: 'Invalid input', 
        details: parse.error.flatten() 
      })
    }

    const { email, resetToken, newPassword } = parse.data

    // Verify the reset token is still valid (check if OTP was recently verified)
    const [otpRecord] = await db.select().from(emailOtps).where(and(
      eq(emailOtps.email, email),
      eq(emailOtps.otp, resetToken),
      eq(emailOtps.verified, true),
      gte(emailOtps.verifiedAt, new Date(Date.now() - 30 * 60 * 1000).toISOString()), // Valid for 30 minutes (increased)
    )).limit(1)


    if (!otpRecord) {
      // Try to find any OTP record for debugging
      const [anyOtpRecord] = await db.select().from(emailOtps).where(and(
        eq(emailOtps.email, email),
        eq(emailOtps.otp, resetToken),
      )).limit(1)

      //console.log('🔍 Any OTP record for debugging:', anyOtpRecord)

      // If we have an OTP record but it's not verified, try to verify it again
      if (anyOtpRecord && !anyOtpRecord.verified) {
        //console.log('🔄 Attempting to re-verify OTP for password reset')
        const verifyResult = await emailService.verifyOTP(email, resetToken)
        
        if (verifyResult.success) {
          //console.log('✅ OTP re-verification successful, proceeding with password reset')
          // Continue with password reset
        } else {
          return res.status(400).json({ 
            error: 'Invalid or expired reset token. Please request a new password reset.',
            debug: process.env.NODE_ENV === 'development' ? {
              foundRecord: !!anyOtpRecord,
              recordVerified: anyOtpRecord?.verified,
              recordVerifiedAt: anyOtpRecord?.verifiedAt,
              reverifyResult: verifyResult
            } : undefined
          })
        }
      } else {
        return res.status(400).json({ 
          error: 'Invalid or expired reset token. Please request a new password reset.',
          debug: process.env.NODE_ENV === 'development' ? {
            foundRecord: !!anyOtpRecord,
            recordVerified: anyOtpRecord?.verified,
            recordVerifiedAt: anyOtpRecord?.verifiedAt
          } : undefined
        })
      }
    }

    // Get user
    const [user] = await db.select({ id: profiles.id, email: profiles.email, first_name: profiles.firstName }).from(profiles).where(eq(profiles.email, email)).limit(1)

    if (!user) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Hash new password
    const saltRounds = 12
    const hashedPassword = await bcrypt.hash(newPassword, saltRounds)

    // Update password in database
    try {
      await db.update(profiles).set({
        passwordHash: hashedPassword,
        updatedAt: new Date().toISOString()
      }).where(eq(profiles.email, email))
    } catch (updateError) {
      console.error('Password update error:', updateError)
      return res.status(500).json({ error: 'Failed to update password' })
    }

    // Invalidate the reset token by deleting the OTP record
    await db.delete(emailOtps).where(and(eq(emailOtps.email, email), eq(emailOtps.otp, resetToken)))

    // Send password reset confirmation email
    try {
      await emailService.sendPasswordResetConfirmation(email, user.first_name || 'User')
    } catch (emailError) {
      console.error('Failed to send password reset confirmation email:', emailError)
      // Don't fail the request if email fails
    }

    //console.log(`✅ Password reset successful for user: ${email}`)

    return res.json({
      success: true,
      message: 'Password reset successfully. You can now sign in with your new password.',
    })
  } catch (error) {
    console.error('Reset password error:', error)
    return res.status(500).json({ error: 'Failed to reset password' })
  }
})

export default router
