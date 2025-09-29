import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import axios from 'axios'
import crypto from 'crypto'

const router = Router()

// OAuth configuration
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET
const INSTAGRAM_CLIENT_ID = process.env.INSTAGRAM_CLIENT_ID
const INSTAGRAM_CLIENT_SECRET = process.env.INSTAGRAM_CLIENT_SECRET
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8081'

// Generate OAuth state for security
function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('hex')
}

// Store OAuth states temporarily (in production, use Redis)
const oauthStates = new Map<string, { userId: string, platform: string, expiresAt: number }>()

// Clean up expired states
setInterval(() => {
  const now = Date.now()
  for (const [state, data] of oauthStates.entries()) {
    if (data.expiresAt < now) {
      oauthStates.delete(state)
    }
  }
}, 5 * 60 * 1000) // Clean up every 5 minutes

// Get user's linked social accounts
router.get('/linked-accounts', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    const { data: accounts, error } = await supabase
      .from('linked_social_accounts')
      .select(`
        id,
        platform,
        platform_username,
        platform_display_name,
        platform_profile_url,
        platform_avatar_url,
        is_verified,
        is_public,
        linked_at,
        platform_data
      `)
      .eq('user_id', userId)
      .is('deleted_at', null) // Only show active accounts
      .order('linked_at', { ascending: false })

    if (error) {
      console.error('Error fetching linked accounts:', error)
      return res.status(500).json({ error: 'Failed to fetch linked accounts' })
    }

    res.json({ accounts: accounts || [] })
  } catch (error) {
    console.error('Error in get linked accounts:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Get linked accounts for a specific user (public view)
router.get('/user/:userId/linked-accounts', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params

    const { data: accounts, error } = await supabase
      .from('linked_social_accounts')
      .select(`
        platform,
        platform_username,
        platform_display_name,
        platform_profile_url,
        platform_avatar_url,
        linked_at,
        platform_data
      `)
      .eq('user_id', userId)
      .eq('is_public', true)
      .eq('is_verified', true)
      .is('deleted_at', null) // Only show active accounts
      .order('linked_at', { ascending: false })

    if (error) {
      console.error('Error fetching user linked accounts:', error)
      return res.status(500).json({ error: 'Failed to fetch linked accounts' })
    }

    res.json({ accounts: accounts || [] })
  } catch (error) {
    console.error('Error in get user linked accounts:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Start Spotify OAuth flow
router.post('/link/spotify', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!SPOTIFY_CLIENT_ID) {
      return res.status(500).json({ error: 'Spotify OAuth not configured' })
    }

    const userId = req.user!.id
    const state = generateOAuthState()
    
    // Store state with expiration (10 minutes)
    oauthStates.set(state, {
      userId,
      platform: 'spotify',
      expiresAt: Date.now() + 10 * 60 * 1000
    })

    const scopes = [
      'user-read-private',
      'user-read-email',
      'user-top-read',
      'user-read-recently-played',
      'playlist-read-private'
    ].join(' ')

    const authUrl = `https://accounts.spotify.com/authorize?` +
      `response_type=code&` +
      `client_id=${SPOTIFY_CLIENT_ID}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `redirect_uri=${encodeURIComponent(`${FRONTEND_URL}/auth/spotify/callback`)}&` +
      `state=${state}`

    res.json({ authUrl, state })
  } catch (error) {
    console.error('Error starting Spotify OAuth:', error)
    res.status(500).json({ error: 'Failed to start Spotify OAuth' })
  }
})

// Verify Instagram login status and fetch username from session
router.post('/verify/instagram-session', requireAuth, async (req: AuthRequest, res) => {
  try {
    console.log('📥 Instagram session verification request received');
    
    const { sessionData } = req.body
    const userId = req.user!.id

    if (!sessionData || !sessionData.username) {
      return res.status(400).json({ 
        error: 'Not logged into Instagram',
        message: 'Please log into Instagram first to verify your account'
      })
    }

    const username = sessionData.username.trim().replace('@', '')
    
    // Validate username format
    const usernameRegex = /^[a-zA-Z0-9._]+$/
    if (!usernameRegex.test(username) || username.length > 30) {
      return res.status(400).json({ error: 'Invalid Instagram username format' })
    }

    // Check if this Instagram username is already linked to another user (only active accounts)
    const { data: existingAccount } = await supabase
      .from('linked_social_accounts')
      .select('user_id')
      .eq('platform', 'instagram')
      .eq('platform_username', username)
      .neq('user_id', userId)
      .is('deleted_at', null)
      .maybeSingle()

    if (existingAccount) {
      return res.status(400).json({ error: 'This Instagram account is already linked to another user' })
    }

    // Check if current user has an existing Instagram account
    const { data: userExistingAccount } = await supabase
      .from('linked_social_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'instagram')
      .maybeSingle()

    let isReactivation = false
    if (userExistingAccount) {
      if (userExistingAccount.platform_username === username && userExistingAccount.deleted_at) {
        isReactivation = true
      }
    }

    let dbError
    
    if (isReactivation) {
      // Reactivate existing account
      console.log('🔄 Reactivating existing Instagram account:', username);
      const { error } = await supabase
        .from('linked_social_accounts')
        .update({
          deleted_at: null,
          is_verified: true,
          is_public: true,
          platform_data: {
            ...userExistingAccount.platform_data,
            verification_method: 'session_verification',
            verified_at: new Date().toISOString(),
            reactivated_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', userExistingAccount.id)
      
      dbError = error
    } else {
      // Create new account or update existing
      console.log('➕ Creating/updating Instagram account:', username);
      
      if (userExistingAccount && !userExistingAccount.deleted_at && userExistingAccount.platform_username !== username) {
        console.log('🗑️ Soft deleting old Instagram account:', userExistingAccount.platform_username);
        await supabase
          .from('linked_social_accounts')
          .update({
            deleted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', userExistingAccount.id)
      }
      
      const { error } = await supabase
        .from('linked_social_accounts')
        .upsert({
          user_id: userId,
          platform: 'instagram',
          platform_user_id: username,
          platform_username: username,
          platform_display_name: username,
          platform_profile_url: `https://instagram.com/${username}`,
          platform_data: {
            verification_method: 'session_verification',
            verified_at: new Date().toISOString(),
            session_verified: true
          },
          is_verified: true,
          is_public: true,
          linked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null
        }, {
          onConflict: 'user_id,platform'
        })
      
      dbError = error
    }

    if (dbError) {
      console.error('Error storing Instagram account:', dbError)
      return res.status(500).json({ error: 'Failed to link Instagram account' })
    }

    res.json({ 
      success: true, 
      message: isReactivation 
        ? 'Instagram account reactivated successfully'
        : 'Instagram account verified and linked successfully',
      account: {
        platform: 'instagram',
        username: username,
        profile_url: `https://instagram.com/${username}`,
        verification_method: 'session_verification',
        is_reactivation: isReactivation
      }
    })

  } catch (error) {
    console.error('Error in Instagram session verification:', error)
    res.status(500).json({ error: 'Failed to verify Instagram session' })
  }
})

// Instagram WebView verification (legacy - manual input)
router.post('/verify/instagram', requireAuth, async (req: AuthRequest, res) => {
  try {
    console.log('📥 Instagram verification request received');
    console.log('📥 Request body:', JSON.stringify(req.body));
    console.log('📥 Content-Type:', req.headers['content-type']);
    
    const { username } = req.body
    const userId = req.user!.id

    console.log('📥 Extracted username:', JSON.stringify(username));
    console.log('📥 Username type:', typeof username);
    console.log('📥 User ID:', userId);

    if (!username) {
      console.log('❌ Username validation failed: empty username');
      return res.status(400).json({ error: 'Instagram username is required' })
    }

    // Validate username format (Instagram usernames: letters, numbers, periods, underscores)
    const usernameRegex = /^[a-zA-Z0-9._]+$/
    if (!usernameRegex.test(username) || username.length > 30) {
      return res.status(400).json({ error: 'Invalid Instagram username format' })
    }

    // Check if this Instagram username is already linked to another user (only active accounts)
    const { data: existingAccount } = await supabase
      .from('linked_social_accounts')
      .select('user_id')
      .eq('platform', 'instagram')
      .eq('platform_username', username)
      .neq('user_id', userId)
      .is('deleted_at', null) // Only check active accounts
      .maybeSingle()

    if (existingAccount) {
      return res.status(400).json({ error: 'This Instagram account is already linked to another user' })
    }

    // Check if current user has an existing Instagram account (active or soft-deleted)
    const { data: userExistingAccount } = await supabase
      .from('linked_social_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', 'instagram')
      .maybeSingle()

    let isReactivation = false
    if (userExistingAccount) {
      // If same username, reactivate
      if (userExistingAccount.platform_username === username && userExistingAccount.deleted_at) {
        isReactivation = true
      }
      // If different username and current is soft-deleted, allow new one
      // If different username and current is active, this will be an upsert (replace)
    }

    let dbError
    
    if (isReactivation) {
      // Reactivate existing account with same username
      console.log('🔄 Reactivating existing Instagram account:', username);
      const { error } = await supabase
        .from('linked_social_accounts')
        .update({
          deleted_at: null, // Reactivate
          is_verified: true,
          is_public: true,
          platform_data: {
            ...userExistingAccount.platform_data,
            verification_method: 'webview_login',
            verified_at: new Date().toISOString(),
            reactivated_at: new Date().toISOString()
          },
          updated_at: new Date().toISOString()
        })
        .eq('id', userExistingAccount.id)
      
      dbError = error
    } else {
      // Create new account or update existing active account
      console.log('➕ Creating/updating Instagram account:', username);
      
      // If user has a different active Instagram account, soft delete it first
      if (userExistingAccount && !userExistingAccount.deleted_at && userExistingAccount.platform_username !== username) {
        console.log('🗑️ Soft deleting old Instagram account:', userExistingAccount.platform_username);
        await supabase
          .from('linked_social_accounts')
          .update({
            deleted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('id', userExistingAccount.id)
      }
      
      // Store new Instagram account
      const { error } = await supabase
        .from('linked_social_accounts')
        .upsert({
          user_id: userId,
          platform: 'instagram',
          platform_user_id: username, // Use username as ID since we don't have API access
          platform_username: username,
          platform_display_name: username,
          platform_profile_url: `https://instagram.com/${username}`,
          platform_data: {
            verification_method: 'webview_login',
            verified_at: new Date().toISOString()
          },
          is_verified: true,
          is_public: true, // Default to public
          linked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          deleted_at: null // Ensure it's active
        }, {
          onConflict: 'user_id,platform'
        })
      
      dbError = error
    }

    if (dbError) {
      console.error('Error storing Instagram account:', dbError)
      return res.status(500).json({ error: 'Failed to link Instagram account' })
    }

    res.json({ 
      success: true, 
      message: isReactivation 
        ? 'Instagram account reactivated successfully'
        : 'Instagram account verified and linked successfully',
      account: {
        platform: 'instagram',
        username: username,
        profile_url: `https://instagram.com/${username}`,
        verification_method: 'webview_login',
        is_reactivation: isReactivation
      }
    })

  } catch (error) {
    console.error('Error in Instagram verification:', error)
    res.status(500).json({ error: 'Failed to verify Instagram account' })
  }
})

// Start Instagram OAuth flow (legacy - kept for compatibility)
router.post('/link/instagram', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!INSTAGRAM_CLIENT_ID) {
      return res.status(500).json({ error: 'Instagram OAuth not configured' })
    }

    const userId = req.user!.id
    const state = generateOAuthState()
    
    // Store state with expiration (10 minutes)
    oauthStates.set(state, {
      userId,
      platform: 'instagram',
      expiresAt: Date.now() + 10 * 60 * 1000
    })

    const scopes = ['user_profile', 'user_media'].join(',')

    const authUrl = `https://api.instagram.com/oauth/authorize?` +
      `client_id=${INSTAGRAM_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(`${FRONTEND_URL}/auth/instagram/callback`)}&` +
      `scope=${scopes}&` +
      `response_type=code&` +
      `state=${state}`

    res.json({ authUrl, state })
  } catch (error) {
    console.error('Error starting Instagram OAuth:', error)
    res.status(500).json({ error: 'Failed to start Instagram OAuth' })
  }
})

// Handle Spotify OAuth callback
router.post('/callback/spotify', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.body

    if (oauthError) {
      return res.status(400).json({ error: `OAuth error: ${oauthError}` })
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state parameter' })
    }

    // Verify state
    const stateData = oauthStates.get(state)
    if (!stateData || stateData.platform !== 'spotify') {
      return res.status(400).json({ error: 'Invalid or expired state' })
    }

    // Clean up state
    oauthStates.delete(state)

    // Exchange code for access token
    const tokenResponse = await axios.post('https://accounts.spotify.com/api/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${FRONTEND_URL}/auth/spotify/callback`,
      client_id: SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })

    const { access_token, refresh_token, expires_in } = tokenResponse.data

    // Get user profile from Spotify
    const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${access_token}` }
    })

    const spotifyProfile = profileResponse.data

    // Get additional data (top artists, playlists)
    const [topArtistsResponse, playlistsResponse] = await Promise.all([
      axios.get('https://api.spotify.com/v1/me/top/artists?limit=5', {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: { items: [] } })),
      axios.get('https://api.spotify.com/v1/me/playlists?limit=10', {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: { items: [] } }))
    ])

    const platformData = {
      followers: spotifyProfile.followers?.total || 0,
      country: spotifyProfile.country,
      top_artists: topArtistsResponse.data.items?.slice(0, 3).map((artist: any) => ({
        name: artist.name,
        genres: artist.genres,
        image: artist.images?.[0]?.url
      })) || [],
      playlists_count: playlistsResponse.data.total || 0,
      public_playlists: playlistsResponse.data.items?.filter((p: any) => p.public).length || 0
    }

    // Store in database
    const { error: dbError } = await supabase
      .from('linked_social_accounts')
      .upsert({
        user_id: stateData.userId,
        platform: 'spotify',
        platform_user_id: spotifyProfile.id,
        platform_username: spotifyProfile.id,
        platform_display_name: spotifyProfile.display_name || spotifyProfile.id,
        platform_profile_url: spotifyProfile.external_urls?.spotify,
        platform_avatar_url: spotifyProfile.images?.[0]?.url,
        access_token, // In production, encrypt this
        refresh_token, // In production, encrypt this
        token_expires_at: new Date(Date.now() + expires_in * 1000).toISOString(),
        platform_data: platformData,
        is_verified: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,platform'
      })

    if (dbError) {
      console.error('Error storing Spotify account:', dbError)
      return res.status(500).json({ error: 'Failed to link Spotify account' })
    }

    res.json({ 
      success: true, 
      message: 'Spotify account linked successfully',
      account: {
        platform: 'spotify',
        username: spotifyProfile.display_name || spotifyProfile.id,
        profile_url: spotifyProfile.external_urls?.spotify,
        avatar_url: spotifyProfile.images?.[0]?.url
      }
    })

  } catch (error) {
    console.error('Error in Spotify callback:', error)
    res.status(500).json({ error: 'Failed to complete Spotify OAuth' })
  }
})

// Handle Instagram OAuth callback
router.post('/callback/instagram', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.body

    if (oauthError) {
      return res.status(400).json({ error: `OAuth error: ${oauthError}` })
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state parameter' })
    }

    // Verify state
    const stateData = oauthStates.get(state)
    if (!stateData || stateData.platform !== 'instagram') {
      return res.status(400).json({ error: 'Invalid or expired state' })
    }

    // Clean up state
    oauthStates.delete(state)

    // Exchange code for access token
    const tokenResponse = await axios.post('https://api.instagram.com/oauth/access_token', {
      client_id: INSTAGRAM_CLIENT_ID,
      client_secret: INSTAGRAM_CLIENT_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: `${FRONTEND_URL}/auth/instagram/callback`,
      code
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })

    const { access_token, user_id } = tokenResponse.data

    // Get user profile from Instagram
    const profileResponse = await axios.get(`https://graph.instagram.com/me?fields=id,username,account_type,media_count&access_token=${access_token}`)
    const instagramProfile = profileResponse.data

    const platformData = {
      account_type: instagramProfile.account_type,
      media_count: instagramProfile.media_count || 0
    }

    // Store in database
    const { error: dbError } = await supabase
      .from('linked_social_accounts')
      .upsert({
        user_id: stateData.userId,
        platform: 'instagram',
        platform_user_id: instagramProfile.id,
        platform_username: instagramProfile.username,
        platform_display_name: instagramProfile.username,
        platform_profile_url: `https://instagram.com/${instagramProfile.username}`,
        access_token, // In production, encrypt this
        platform_data: platformData,
        is_verified: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'user_id,platform'
      })

    if (dbError) {
      console.error('Error storing Instagram account:', dbError)
      return res.status(500).json({ error: 'Failed to link Instagram account' })
    }

    res.json({ 
      success: true, 
      message: 'Instagram account linked successfully',
      account: {
        platform: 'instagram',
        username: instagramProfile.username,
        profile_url: `https://instagram.com/${instagramProfile.username}`
      }
    })

  } catch (error) {
    console.error('Error in Instagram callback:', error)
    res.status(500).json({ error: 'Failed to complete Instagram OAuth' })
  }
})

// Unlink a social account (soft delete)
router.delete('/unlink/:platform', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { platform } = req.params
    const userId = req.user!.id

    if (!['spotify', 'instagram'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform' })
    }

    // Check if account exists and is active
    const { data: existingAccount } = await supabase
      .from('linked_social_accounts')
      .select('*')
      .eq('user_id', userId)
      .eq('platform', platform)
      .is('deleted_at', null)
      .maybeSingle()

    if (!existingAccount) {
      return res.status(404).json({ error: `No active ${platform} account found to unlink` })
    }

    // Soft delete the account
    const { error } = await supabase
      .from('linked_social_accounts')
      .update({
        deleted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform_data: {
          ...existingAccount.platform_data,
          unlinked_at: new Date().toISOString(),
          unlink_reason: 'user_requested'
        }
      })
      .eq('user_id', userId)
      .eq('platform', platform)
      .is('deleted_at', null)

    if (error) {
      console.error('Error unlinking account:', error)
      return res.status(500).json({ error: 'Failed to unlink account' })
    }

    console.log(`🗑️ Soft deleted ${platform} account for user ${userId}:`, existingAccount.platform_username);

    res.json({ 
      success: true, 
      message: `${platform} account unlinked successfully`,
      unlinked_account: {
        platform: platform,
        username: existingAccount.platform_username,
        can_reactivate: true
      }
    })
  } catch (error) {
    console.error('Error in unlink account:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update account visibility
router.patch('/account/:accountId/visibility', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { accountId } = req.params
    const { isPublic } = req.body
    const userId = req.user!.id

    const { error } = await supabase
      .from('linked_social_accounts')
      .update({ is_public: isPublic })
      .eq('id', accountId)
      .eq('user_id', userId)

    if (error) {
      console.error('Error updating account visibility:', error)
      return res.status(500).json({ error: 'Failed to update account visibility' })
    }

    res.json({ success: true, message: 'Account visibility updated' })
  } catch (error) {
    console.error('Error in update account visibility:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

export default router
