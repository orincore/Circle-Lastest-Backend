import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env.js'
import { findByEmail, findByUsername, createProfile } from '../repos/profiles.repo.js'
import { supabase } from '../config/supabase.js'
import { signJwt, verifyJwt } from '../utils/jwt.js'
import { hashPassword, verifyPassword } from '../utils/password.js'
import { NotificationService } from '../services/notificationService.js'
import { trackUserJoined } from '../services/activityService.js'

const router = Router()

const signupSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  age: z.coerce.number().int().min(13).max(120),
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
    .refine((s) => s === '' || /^[a-zA-Z0-9_.-]{3,30}$/.test(s), {
      message: 'Username must be 3-30 chars, allowed: letters, numbers, _, ., -'
    })
    .optional(),
  password: z.string().min(6),
  instagramUsername: z.string()
    .min(1, 'Instagram username must be at least 1 character')
    .max(30, 'Instagram username must be less than 30 characters')
    .refine((s) => /^[a-zA-Z0-9._]+$/.test(s), {
      message: 'Instagram username can only contain letters, numbers, periods, and underscores'
    })
    .optional()
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
  let { email, password, firstName, lastName, age, gender, phoneNumber, about, interests, needs, username, instagramUsername } = parse.data

  // Debug: Log the parsed data to see what we're receiving
  console.log('📝 Parsed signup data:', {
    firstName,
    lastName,
    about: about || '(empty)',
    instagramUsername,
    interests: interests?.length || 0,
    needs: needs?.length || 0
  })

  const normalizedEmail = email.trim().toLowerCase()
  const cleanInstagramUsername = instagramUsername ? instagramUsername.trim().replace('@', '') : ''

  // Validate Instagram username format if provided
  if (cleanInstagramUsername && !/^[a-zA-Z0-9._]+$/.test(cleanInstagramUsername)) {
    return res.status(400).json({ error: 'Invalid Instagram username format' })
  }

  // If username missing or empty, generate from email/name
  let finalUsername = username;
  if (!finalUsername) {
    const baseFrom = (email.split('@')[0] || `${firstName}${lastName}` || 'user').toLowerCase();
    const sanitized = baseFrom.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 30);
    finalUsername = sanitized.length >= 3 ? sanitized : `${sanitized}user`;
  }

  // Ensure uniqueness (check case-insensitively but store exact case)
  const [byEmail, existing] = await Promise.all([
    findByEmail(normalizedEmail),
    findByUsername(finalUsername.toLowerCase()) // Check lowercase for uniqueness
  ])
  if (byEmail) return res.status(409).json({ error: 'Email already in use' })
  if (existing) {
    // If user provided username conflicts, return error
    if (username) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    // If auto-generated username conflicts, try variations
    for (let i = 0; i < 5; i++) {
      const candidate = `${finalUsername.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24)}${Math.floor(Math.random()*100000).toString().padStart(3,'0')}`;
      const hit = await findByUsername(candidate.toLowerCase());
      if (!hit) { finalUsername = candidate; break; }
    }
    const again = await findByUsername(finalUsername.toLowerCase());
    if (again) return res.status(409).json({ error: 'Username generation failed' });
  }

  const password_hash = await hashPassword(password)
  
  // Debug: Log what we're about to save to the database
  const profileData = {
    email: normalizedEmail,
    username: finalUsername,
    first_name: firstName,
    last_name: lastName,
    age,
    gender,
    phone_number: phoneNumber,
    about: about || 'Hello! I\'m excited to connect with new people and make meaningful friendships.',
    interests,
    needs,
    profile_photo_url: env.DEFAULT_PROFILE_PHOTO_URL,
    instagram_username: cleanInstagramUsername || null,
    password_hash
  }
  
  console.log('💾 Creating profile with data:', {
    ...profileData,
    password_hash: '[HIDDEN]',
    about: profileData.about,
    instagram_username: profileData.instagram_username
  })
  
  const profile = await createProfile(profileData)

  // Track user joined activity for live feed
  try {
    await trackUserJoined(profile)
    console.log('✅ Tracked user joined activity for live feed')
  } catch (error) {
    console.error('❌ Failed to track user joined activity:', error)
  }

  // Send notifications to potential matches about new user
  try {
    const newUserName = `${profile.first_name} ${profile.last_name}`.trim();
    
    // Find potential matches for the new user
    // This is a simplified version - you could use the matchmaking algorithm for better matching
    const { data: potentialMatches } = await supabase
      .from('profiles')
      .select('id')
      .neq('id', profile.id)
      .limit(50); // Limit to prevent spam
    
    if (potentialMatches && potentialMatches.length > 0) {
      const matchIds = potentialMatches.map(m => m.id);
      await NotificationService.notifyNewUserSignup(
        profile.id,
        newUserName,
        matchIds
      );
      console.log(`✅ Sent new user notifications to ${matchIds.length} potential matches`);
    }
  } catch (error) {
    console.error('❌ Failed to send new user notifications:', error);
    // Don't fail signup if notifications fail
  }

  const access_token = signJwt({ sub: profile.id, email: profile.email, username: profile.username })
  return res.json({
    access_token,
    user: {
      id: profile.id,
      email: profile.email,
      username: profile.username,
      firstName: profile.first_name,
      lastName: profile.last_name,
      age: profile.age,
      gender: profile.gender,
      phoneNumber: profile.phone_number,
      about: profile.about,
      interests: profile.interests,
      needs: profile.needs,
      profilePhotoUrl: profile.profile_photo_url,
      instagramUsername: profile.instagram_username
    }
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

  const access_token = signJwt({ sub: user.id, email: user.email, username: user.username })
  return res.json({
    access_token,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      age: user.age,
      gender: user.gender,
      phoneNumber: user.phone_number,
      about: user.about,
      interests: user.interests,
      needs: user.needs,
      profilePhotoUrl: user.profile_photo_url,
      instagramUsername: user.instagram_username
    }
  })
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
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        deleted_at: deletionDate.toISOString(),
        deletion_reason: reason,
        deletion_feedback: feedback || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)

    if (updateError) {
      console.error('Error soft deleting account:', updateError)
      return res.status(500).json({ error: 'Failed to delete account' })
    }

    // Log the deletion activity
    try {
      await supabase
        .from('user_activity')
        .insert({
          user_id: user.id,
          action: 'account_deletion_requested',
          details: { reason, feedback, scheduled_for: deletionDate.toISOString() }
        })
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
