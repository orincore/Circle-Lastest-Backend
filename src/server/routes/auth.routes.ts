import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env.js'
import { findByEmail, findByUsername, createProfile } from '../repos/profiles.repo.js'
import { ne, eq, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'
import { issueTokenWithSession, revokeSession } from '../utils/authSession.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { NotificationService } from '../services/notificationService.js'
import { PushNotificationService } from '../services/pushNotificationService.js'
import { trackUserJoined } from '../services/activityService.js'
import emailService from '../services/emailService.js'
import { OAuth2Client } from 'google-auth-library'
import { calculateAge, isValidDateOfBirth, MIN_AGE } from '../utils/age.js'
import { AuthRequest, requireAuth } from '../middleware/auth.js'

const router = Router()

// Google OAuth configuration
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET) : null

const signupSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  dateOfBirth: z.coerce.date().refine(isValidDateOfBirth, {
    message: `You must be at least ${MIN_AGE} years old`,
  }),
  gender: z.string().min(1),
  email: z.string().email(),
  phoneNumber: z.string().min(5).optional(),
  about: z.string()
    .min(10, 'About section must be at least 10 characters')
    .max(500, 'About section must be less than 500 characters')
    .optional(),
  interests: z.array(z.string()).default([]),
  needs: z.array(z.string()).default([]),
  username: z.string()
    .trim()
    .min(3, 'Username must be at least 3 characters')
    .max(30, 'Username must be less than 30 characters')
    .refine((s) => /^[a-zA-Z0-9_.-]{3,30}$/.test(s), {
      message: 'Username must be 3-30 chars, allowed: letters, numbers, _, ., -'
    }),
  password: z.string().min(6),
  instagramUsername: z.string()
    .min(1, 'Instagram username must be at least 1 character')
    .max(30, 'Instagram username must be less than 30 characters')
    .refine((s) => /^[a-zA-Z0-9._]+$/.test(s), {
      message: 'Instagram username can only contain letters, numbers, periods, and underscores'
    })
    .optional(),
  referralCode: z.string().optional()
})

// Username availability
router.get('/username-available', async (req, res) => {
  try {
    const raw = String(req.query.username || '').trim().toLowerCase()
    if (!raw) return res.status(400).json({ error: 'Missing username' })
    const exists = await findByUsername(raw)
    return res.json({ available: !exists })
  } catch (e) {
    return res.status(500).json({ error: 'Failed to check username' })
  }
})

router.post('/signup', async (req, res) => {
 
  
  const parse = signupSchema.safeParse(req.body)
  if (!parse.success) {
    try {
      const payload = {
        body: req.body,
        errors: parse.error.flatten(),
      };
      console.error('[auth] Signup validation failed\n' + JSON.stringify(payload, null, 2));
    } catch {}
    return res.status(400).json({ error: 'Invalid body', details: parse.error.flatten() })
  }
  let { email, password, firstName, lastName, dateOfBirth, gender, phoneNumber, about, interests, needs, username, instagramUsername, referralCode } = parse.data
  const age = calculateAge(dateOfBirth)
  const dateOfBirthStr = dateOfBirth.toISOString().slice(0, 10)

  // Debug: Log the parsed data to see what we're receiving
  

  const normalizedEmail = email.trim().toLowerCase()
  const cleanInstagramUsername = instagramUsername ? instagramUsername.trim().replace('@', '') : ''
  const cleanReferralCode = referralCode ? referralCode.trim().toUpperCase() : null

  // Validate Instagram username format if provided
  if (cleanInstagramUsername && !/^[a-zA-Z0-9._]+$/.test(cleanInstagramUsername)) {
    return res.status(400).json({ error: 'Invalid Instagram username format' })
  }

  // Use the exact username provided (now required)
  const finalUsername = username.trim();

  // Check for existing email and username
  const [byEmail, existing] = await Promise.all([
    findByEmail(normalizedEmail),
    findByUsername(finalUsername.toLowerCase()) // Check lowercase for uniqueness
  ])
  
  if (byEmail) return res.status(409).json({ error: 'Email already in use' })
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const password_hash = await hashPassword(password)
  
  // Debug: Log what we're about to save to the database
  const profileData = {
    email: normalizedEmail,
    username: finalUsername,
    first_name: firstName,
    last_name: lastName,
    age,
    date_of_birth: dateOfBirthStr,
    gender,
    phone_number: phoneNumber,
    about: about || 'Hello! I\'m excited to connect with new people and make meaningful friendships.',
    interests,
    needs,
    profile_photo_url: env.DEFAULT_PROFILE_PHOTO_URL,
    instagram_username: cleanInstagramUsername || null,
    password_hash
  }
  
  
  
  const profile = await createProfile(profileData)

  // Track user joined activity for live feed
  try {
    await trackUserJoined(profile)
    //console.log('✅ Tracked user joined activity for live feed')
  } catch (error) {
    console.error('❌ Failed to track user joined activity:', error)
  }

  // Send notifications to potential matches about new user
  try {
    const newUserName = `${profile.first_name} ${profile.last_name}`.trim();
    
    // Find potential matches for the new user
    // This is a simplified version - you could use the matchmaking algorithm for better matching
    const potentialMatches = await db.select({ id: profiles.id }).from(profiles).where(ne(profiles.id, profile.id)).limit(50) // Limit to prevent spam
    
    if (potentialMatches && potentialMatches.length > 0) {
      const matchIds = potentialMatches.map(m => m.id);
      await NotificationService.notifyNewUserSignup(
        profile.id,
        newUserName,
        matchIds
      );
      //console.log(`✅ Sent new user notifications to ${matchIds.length} potential matches`);
    }
  } catch (error) {
    console.error('❌ Failed to send new user notifications:', error);
    // Don't fail signup if notifications fail
  }

  // Welcome email will be sent after email verification, not at signup

  // Handle referral code if provided
  let referralInfo = null;
  if (cleanReferralCode) {
    try {
      // Dynamically import the referral function
      const { applyReferralCode } = await import('./referral.routes.js');
      const result = await applyReferralCode(
        profile.id, 
        cleanReferralCode, 
        req.ip || req.connection?.remoteAddress, 
        req.get('User-Agent')
      );
      
      if (result.success) {
        referralInfo = { 
          code: cleanReferralCode, 
          status: 'pending',
          referralNumber: result.referralNumber
        };
        console.log(`✅ Referral code ${cleanReferralCode} applied successfully for user ${profile.id}`);
      } else {
        console.log(`⚠️ Referral code ${cleanReferralCode} failed: ${result.error}`);
        referralInfo = { code: cleanReferralCode, status: 'failed', error: result.error };
      }
    } catch (error) {
      console.error('Failed to process referral code:', error);
      // Don't fail signup if referral processing fails
      referralInfo = { code: cleanReferralCode, status: 'error' };
    }
  }

  const access_token = await issueTokenWithSession(req, { id: profile.id, email: profile.email, username: profile.username })
  return res.json({
    access_token,
    user: {
      id: profile.id,
      email: profile.email,
      username: profile.username,
      firstName: profile.first_name,
      lastName: profile.last_name,
      age: profile.age,
      dateOfBirth: profile.date_of_birth,
      gender: profile.gender,
      phoneNumber: profile.phone_number,
      about: profile.about,
      interests: profile.interests,
      needs: profile.needs,
      profilePhotoUrl: profile.profile_photo_url,
      instagramUsername: profile.instagram_username,
      emailVerified: false // New users need to verify email
    },
    referralInfo
  })
})

const loginSchema = z.object({
  identifier: z.string().min(3), // email or username
  password: z.string().min(6)
})

router.post('/login', async (req, res) => {
  const parse = loginSchema.safeParse(req.body)
  if (!parse.success) return res.status(400).json({ error: 'Invalid body', details: parse.error.flatten() })
  const { identifier, password } = parse.data

  const raw = identifier.trim()
  let email = raw

  let user = null
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
    email = raw.toLowerCase()
    user = await findByEmail(email)
  } else {
    user = await findByUsername(raw.toLowerCase())
  }
  if (!user) return res.status(400).json({ error: 'Invalid credentials' })
  const ok = await verifyPassword(password, user.password_hash)
  if (!ok) return res.status(400).json({ error: 'Invalid credentials' })

  const access_token = await issueTokenWithSession(req, { id: user.id, email: user.email, username: user.username })

  // Send login alert email (async, don't wait for it)
  const loginInfo = {
    device: req.get('User-Agent') || 'Unknown device',
    location: 'Unknown location', // You can integrate with IP geolocation service
    ip: req.ip || req.connection.remoteAddress || 'Unknown IP',
    timestamp: new Date().toLocaleString(),
  }
  
  // Send login alert (don't await to avoid slowing down login)
  emailService.sendLoginAlert(user.email, user.first_name || 'User', loginInfo)
    .catch(error => console.error('Failed to send login alert:', error))
  
  //console.log('🔍 [Login] User email_verified field:', user.email_verified);
  //console.log('🔍 [Login] User object keys:', Object.keys(user));
  
  const loginResponse = {
    access_token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      age: user.age,
      dateOfBirth: user.date_of_birth,
      gender: user.gender,
      phoneNumber: user.phone_number,
      about: user.about,
      interests: user.interests,
      needs: user.needs,
      profilePhotoUrl: user.profile_photo_url,
      instagramUsername: user.instagram_username,
      emailVerified: user.email_verified || false
    },
    needsDobMigration: !user.date_of_birth
  };
  
  //console.log('🔍 [Login] Response emailVerified:', loginResponse.user.emailVerified);
  
  return res.json(loginResponse)
})

/**
 * Logout: revokes the CURRENT session (blacklists its jti so this exact
 * token is rejected on its very next request once ENFORCE_SESSION_REVOCATION
 * is on -- see middleware/auth.ts) and disables push tokens for this
 * device, so a logged-out device stops receiving pushes immediately.
 *
 * Deliberately best-effort/non-throwing internally (revokeSession and
 * disablePushTokensForDevice already log-and-continue on failure) so this
 * route always returns success -- the client clears its local token
 * regardless, and a partial failure here just means enforcement lags
 * slightly rather than the user being stuck unable to log out.
 */
router.post('/logout', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { deviceId, token } = req.body as { deviceId?: string; token?: string }

    if (req.jti) {
      await revokeSession(req.jti, 'logout')
    }
    await PushNotificationService.disablePushTokensForDevice(req.user!.id, { deviceId, token })

    return res.json({ success: true, message: 'Logged out successfully' })
  } catch (error) {
    console.error('Logout error:', error)
    // Even on an unexpected error, the client should treat itself as logged
    // out locally -- this endpoint is a best-effort server-side cleanup.
    return res.status(500).json({ error: 'Failed to log out' })
  }
})

// Google OAuth Login/Signup
router.post('/google', async (req, res) => {
  try {
    const { idToken } = req.body

    if (!idToken) {
      return res.status(400).json({ error: 'Google ID token is required' })
    }

    if (!googleClient) {
      return res.status(500).json({ error: 'Google OAuth not configured' })
    }

    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    })

    const payload = ticket.getPayload()
    if (!payload) {
      return res.status(400).json({ error: 'Invalid Google token' })
    }

    const { email, given_name, family_name, picture, email_verified } = payload

    if (!email || !email_verified) {
      return res.status(400).json({ error: 'Google email not verified' })
    }

    // Check if user already exists
    const existingUser = await findByEmail(email.toLowerCase())

    if (existingUser) {
      // User exists - log them in
      const access_token = await issueTokenWithSession(req, { id: existingUser.id, email: existingUser.email, username: existingUser.username })

      // Send login alert email (async, don't wait for it)
      const loginInfo = {
        device: req.get('User-Agent') || 'Unknown device',
        location: 'Unknown location',
        ip: req.ip || req.connection?.remoteAddress || 'Unknown IP',
        timestamp: new Date().toLocaleString(),
        method: 'Google OAuth'
      }
      
      emailService.sendLoginAlert(existingUser.email, existingUser.first_name || 'User', loginInfo)
        .catch(error => console.error('Failed to send login alert:', error))

      return res.json({
        access_token,
        user: {
          id: existingUser.id,
          email: existingUser.email,
          username: existingUser.username,
          firstName: existingUser.first_name,
          lastName: existingUser.last_name,
          age: existingUser.age,
          dateOfBirth: existingUser.date_of_birth,
          gender: existingUser.gender,
          phoneNumber: existingUser.phone_number,
          about: existingUser.about,
          interests: existingUser.interests,
          needs: existingUser.needs,
          profilePhotoUrl: existingUser.profile_photo_url,
          instagramUsername: existingUser.instagram_username,
          emailVerified: existingUser.email_verified || false
        },
        isNewUser: false,
        needsDobMigration: !existingUser.date_of_birth
      })
    }

    // New user - return Google profile data for signup completion
    return res.json({
      isNewUser: true,
      googleProfile: {
        email: email.toLowerCase(),
        firstName: given_name || '',
        lastName: family_name || '',
        profilePhotoUrl: picture || null,
        emailVerified: true // Google emails are pre-verified
      }
    })

  } catch (error) {
    console.error('Google OAuth error:', error)
    return res.status(500).json({ error: 'Google authentication failed' })
  }
})

// Complete Google OAuth Signup
router.post('/google/complete-signup', async (req, res) => {
  try {
    const {
      idToken,
      firstName,
      lastName,
      dateOfBirth,
      gender,
      username,
      phoneNumber,
      interests,
      needs,
      instagramUsername,
      about
    } = req.body

    if (!idToken) {
      return res.status(400).json({ error: 'Google ID token is required' })
    }

    if (!googleClient) {
      return res.status(500).json({ error: 'Google OAuth not configured' })
    }

    // Verify the Google ID token again
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    })

    const payload = ticket.getPayload()
    if (!payload || !payload.email || !payload.email_verified) {
      return res.status(400).json({ error: 'Invalid Google token' })
    }

    const email = payload.email.toLowerCase()
    const profilePicture = payload.picture

    // Validate required fields
    if (!firstName || !lastName || !dateOfBirth || !gender || !username) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    if (!isValidDateOfBirth(new Date(dateOfBirth))) {
      return res.status(400).json({ error: `You must be at least ${MIN_AGE} years old` })
    }

    const age = calculateAge(new Date(dateOfBirth))
    const dateOfBirthStr = new Date(dateOfBirth).toISOString().slice(0, 10)

    // Check if email is already taken
    const existingUser = await findByEmail(email)
    if (existingUser) {
      return res.status(409).json({ error: 'Email already in use' })
    }

    // Check if username is already taken
    const existingUsername = await findByUsername(username.toLowerCase())
    if (existingUsername) {
      return res.status(409).json({ error: 'Username already taken' })
    }

    // Create profile data
    // Generate a random password hash for Google OAuth users (they won't use it)
    const randomPassword = `google_oauth_${Date.now()}_${Math.random().toString(36)}`
    const googlePasswordHash = await hashPassword(randomPassword)
    
    const profileData = {
      email,
      username: username.trim(),
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      age,
      date_of_birth: dateOfBirthStr,
      gender: gender.trim(),
      phone_number: phoneNumber || null,
      about: about || 'Hello! I\'m excited to connect with new people and make meaningful friendships.',
      interests: Array.isArray(interests) ? interests : [],
      needs: Array.isArray(needs) ? needs : [],
      profile_photo_url: profilePicture || env.DEFAULT_PROFILE_PHOTO_URL,
      instagram_username: instagramUsername ? instagramUsername.trim().replace('@', '') : null,
      password_hash: googlePasswordHash, // Random hash for Google OAuth users
      email_verified: true // Google emails are pre-verified
    }

    const profile = await createProfile(profileData)

    // Track user joined activity
    try {
      await trackUserJoined(profile)
    } catch (error) {
      console.error('❌ Failed to track user joined activity:', error)
    }

    // Send notifications to potential matches
    try {
      const newUserName = `${profile.first_name} ${profile.last_name}`.trim()
      
      const potentialMatches = await db.select({ id: profiles.id }).from(profiles).where(ne(profiles.id, profile.id)).limit(50) // Limit to prevent spam
      
      if (potentialMatches && potentialMatches.length > 0) {
        const matchIds = potentialMatches.map(m => m.id)
        await NotificationService.notifyNewUserSignup(
          profile.id,
          newUserName,
          matchIds
        )
      }
    } catch (error) {
      console.error('❌ Failed to send new user notifications:', error)
    }

    const access_token = await issueTokenWithSession(req, { id: profile.id, email: profile.email, username: profile.username })

    return res.json({
      access_token,
      user: {
        id: profile.id,
        email: profile.email,
        username: profile.username,
        firstName: profile.first_name,
        lastName: profile.last_name,
        age: profile.age,
        dateOfBirth: profile.date_of_birth,
        gender: profile.gender,
        phoneNumber: profile.phone_number,
        about: profile.about,
        interests: profile.interests,
        needs: profile.needs,
        profilePhotoUrl: profile.profile_photo_url,
        instagramUsername: profile.instagram_username,
        emailVerified: true // Google users are pre-verified
      },
      isNewUser: true
    })

  } catch (error) {
    console.error('Google OAuth complete signup error:', error)
    return res.status(500).json({ error: 'Failed to complete Google signup' })
  }
})

// Delete account endpoint (soft delete)
router.post('/delete-account', async (req, res) => {
  try {
    const { email, password, reason, feedback } = req.body

    // Validate input
    if (!email || !password || !reason) {
      return res.status(400).json({ error: 'Email, password, and reason are required' })
    }

    // Find user by email
    const user = await findByEmail(email.toLowerCase())
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    // Verify password
    const isValid = await verifyPassword(password, user.password_hash)
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    // Check if already deleted
    if (user.deleted_at) {
      return res.status(400).json({ error: 'Account is already scheduled for deletion' })
    }

    // Soft delete: Set deleted_at timestamp and deletion reason
    const deletionDate = new Date()
    try {
      await db.update(profiles).set({
        deletedAt: deletionDate.toISOString(),
        deletionReason: reason,
        deletionFeedback: feedback || null,
        updatedAt: new Date().toISOString(),
      }).where(eq(profiles.id, user.id))
    } catch (updateError) {
      console.error('Error soft deleting account:', updateError)
      return res.status(500).json({ error: 'Failed to delete account' })
    }

    // Log the deletion activity
    // NOTE: `user_activity` is not a real table (the schema has `user_activities` and
    // `user_activity_events`, neither an exact match) - this insert has been silently
    // failing in production via the catch below even before this migration. Preserved
    // as-is rather than guessing which real table was intended; that's a product
    // decision for whoever owns this code, not something to silently change here.
    try {
      await db.execute(sql`insert into user_activity (user_id, action, details) values (${user.id}, ${'account_deletion_requested'}, ${JSON.stringify({ reason, feedback, scheduled_for: deletionDate.toISOString() })})`)
    } catch (activityError) {
      console.error('Error logging deletion activity:', activityError)
      // Don't fail the request if activity logging fails
    }

    return res.json({
      success: true,
      message: 'Account scheduled for deletion. You have 30 days to reactivate by logging in.',
      deletionDate: deletionDate.toISOString()
    })
  } catch (error) {
    console.error('Delete account error:', error)
    return res.status(500).json({ error: 'Failed to delete account' })
  }
})

export default router
