import express from 'express'
import { db } from '../config/db.js'
import { profiles } from '../db/schema.js'
import { and, eq, ilike, isNull } from 'drizzle-orm'
import { cache, cacheKeys, PROFILE_TTL } from '../services/cache.js'

const router = express.Router()

router.get('/profile/:username', async (req, res) => {
  try {
    const raw = String(req.params.username || '').trim().replace(/^@/, '')
    if (!raw) return res.status(400).json({ error: 'Missing username' })

    const cacheKey = cacheKeys.profilePublic(raw)
    const cached = await cache.getJSON(cacheKey)
    if (cached) return res.json(cached)

    const [profile] = await db.select({
      id: profiles.id,
      username: profiles.username,
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      profile_photo_url: profiles.profilePhotoUrl,
      age: profiles.age,
      gender: profiles.gender,
      about: profiles.about,
      interests: profiles.interests,
      needs: profiles.needs,
      verification_status: profiles.verificationStatus,
      verified_at: profiles.verifiedAt,
      created_at: profiles.createdAt,
      is_suspended: profiles.isSuspended,
      deleted_at: profiles.deletedAt,
    })
      .from(profiles)
      .where(ilike(profiles.username, raw))
      .limit(1)

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (profile.deleted_at || profile.is_suspended) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    const payload = {
      id: profile.id,
      username: profile.username,
      first_name: profile.first_name,
      last_name: profile.last_name,
      profile_photo_url: profile.profile_photo_url,
      age: profile.age,
      gender: profile.gender,
      about: profile.about,
      interests: profile.interests || [],
      needs: profile.needs || [],
      verification_status: profile.verification_status,
      verified_at: profile.verified_at,
      created_at: profile.created_at
    }

    await cache.setJSON(cacheKey, payload, PROFILE_TTL.public)

    return res.json(payload)
  } catch (error) {
    console.error('Error fetching public profile:', error)
    return res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

export default router
