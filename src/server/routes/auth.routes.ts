import { Router } from 'express'
import { z } from 'zod'
import { env } from '../config/env.js'
import { findByEmail, findByUsername, createProfile } from '../repos/profiles.repo.js'
import bcrypt from 'bcryptjs'
import { signJwt } from '../utils/jwt.js'
import { supabase } from '../config/supabase.js'

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
    .min(1, 'Instagram username is required')
    .max(30, 'Instagram username must be less than 30 characters')
    .refine((s) => /^[a-zA-Z0-9._]+$/.test(s), {
      message: 'Instagram username can only contain letters, numbers, periods, and underscores'
    })
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

  const normalizedEmail = email.trim().toLowerCase()

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

  const password_hash = await bcrypt.hash(password, 10)
  const profile = await createProfile({
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
    password_hash
  })

  // Automatically create Instagram account for the user
  try {
    console.log('📸 Creating Instagram account for new user:', instagramUsername);
    
    const { error: instagramError } = await supabase
      .from('linked_social_accounts')
      .insert({
        user_id: profile.id,
        platform: 'instagram',
        platform_user_id: instagramUsername,
        platform_username: instagramUsername,
        platform_display_name: instagramUsername,
        platform_profile_url: `https://instagram.com/${instagramUsername}`,
        platform_data: {
          verification_method: 'signup_verification',
          verified_at: new Date().toISOString()
        },
        is_verified: true,
        is_public: true,
        linked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null
      })

    if (instagramError) {
      console.error('Failed to create Instagram account during signup:', instagramError)
      // Don't fail signup if Instagram account creation fails
    } else {
      console.log('✅ Instagram account created successfully for:', instagramUsername)
    }
  } catch (error) {
    console.error('Error creating Instagram account during signup:', error)
    // Don't fail signup if Instagram account creation fails
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
      profilePhotoUrl: profile.profile_photo_url
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
  const ok = await bcrypt.compare(password, user.password_hash)
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
      profilePhotoUrl: user.profile_photo_url
    }
  })
})

export default router
