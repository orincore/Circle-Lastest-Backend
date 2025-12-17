import express from 'express'
import { supabase } from '../config/supabase.js'

const router = express.Router()

router.get('/profile/:username', async (req, res) => {
  try {
    const raw = String(req.params.username || '').trim().replace(/^@/, '')
    if (!raw) return res.status(400).json({ error: 'Missing username' })

    const { data: profile, error } = await supabase
      .from('profiles')
      .select(`
        id,
        username,
        first_name,
        last_name,
        profile_photo_url,
        age,
        gender,
        about,
        interests,
        needs,
        verification_status,
        verified_at,
        created_at,
        is_suspended,
        deleted_at
      `)
      .ilike('username', raw)
      .maybeSingle()

    if (error || !profile) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    if (profile.deleted_at || profile.is_suspended) {
      return res.status(404).json({ error: 'Profile not found' })
    }

    return res.json({
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
    })
  } catch (error) {
    console.error('Error fetching public profile:', error)
    return res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

export default router
