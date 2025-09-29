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
const INSTAGRAM_VERIFY_TOKEN = process.env.INSTAGRAM_VERIFY_TOKEN
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:8081'

// Generate OAuth state for security
function generateOAuthState(): string {
  return crypto.randomBytes(32).toString('hex')
}

// Store OAuth states temporarily (in production, use Redis)
const oauthStates = new Map<string, { userId: string, platform: string, requestPlatform?: string, expiresAt: number }>()

// Clean up expired states
setInterval(() => {
  const now = Date.now()
  for (const [state, data] of oauthStates.entries()) {
    if (data.expiresAt < now) {
      oauthStates.delete(state)
    }
  }
}, 5 * 60 * 1000) // Clean up every 5 minutes

// Get user's linked social accounts (for own profile)
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
    const { platform } = req.body // Get platform info from request
    
    // Store state with expiration (10 minutes)
    oauthStates.set(state, {
      userId,
      platform: 'spotify',
      requestPlatform: platform || 'web',
      expiresAt: Date.now() + 10 * 60 * 1000
    })

    const scopes = [
      'user-read-private',
      'user-read-email',
      'user-top-read',
      'user-read-recently-played',
      'playlist-read-private'
    ].join(' ')

    // Use different redirect URIs for different platforms
    let redirectUri
    if (platform === 'ios' || platform === 'android') {
      // For mobile apps, use a custom scheme or universal link
      redirectUri = `${FRONTEND_URL}/auth/spotify/callback`
    } else {
      // For web
      redirectUri = `${FRONTEND_URL}/auth/spotify/callback`
    }

    const authUrl = `https://accounts.spotify.com/authorize?` +
      `response_type=code&` +
      `client_id=${SPOTIFY_CLIENT_ID}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `redirect_uri=${encodeURIComponent(redirectUri)}&` +
      `state=${state}&` +
      `show_dialog=true` // Force login dialog for better mobile UX

    console.log('✅ Generated Spotify OAuth URL for platform:', platform);
    console.log('Redirect URI:', redirectUri);
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

    console.log('🔍 Instagram OAuth Debug:');
    console.log('- Client ID exists:', !!INSTAGRAM_CLIENT_ID);
    console.log('- Client ID length:', INSTAGRAM_CLIENT_ID?.length);
    console.log('- Frontend URL:', FRONTEND_URL);
    console.log('- Redirect URI:', `${FRONTEND_URL}/auth/instagram/callback`);

    const userId = req.user!.id
    const state = generateOAuthState()
    
    // Store state with expiration (10 minutes)
    oauthStates.set(state, {
      userId,
      platform: 'instagram',
      expiresAt: Date.now() + 10 * 60 * 1000
    })

    // Use Instagram API with Instagram Login - consumer app scopes
    const scopes = ['instagram_business_basic'].join(',')

    // Instagram API authorization URL
    const authUrl = `https://api.instagram.com/oauth/authorize?` +
      `client_id=${INSTAGRAM_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(`${FRONTEND_URL}/auth/instagram/callback`)}&` +
      `scope=${scopes}&` +
      `response_type=code&` +
      `state=${state}`

    console.log('✅ Generated Instagram OAuth URL:', authUrl);
    res.json({ authUrl, state })
  } catch (error: any) {
    console.error('❌ Error starting Instagram OAuth:', error)
    console.error('Error details:', error.response?.data || error.message)
    res.status(500).json({ 
      error: 'Failed to start Instagram OAuth',
      details: error.response?.data || error.message
    })
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

    // Verify state (allow expo-auth-session default state)
    let stateData = oauthStates.get(state)
    let isExpoAuthSession = false
    
    if (!stateData || stateData.platform !== 'spotify') {
      // Handle expo-auth-session case where state might be 'expo-auth-session'
      if (state === 'expo-auth-session') {
        console.log('⚠️ Using expo-auth-session default state - this should be improved in production');
        isExpoAuthSession = true
        // Create temporary state data - in production, implement proper user identification
        stateData = {
          userId: 'temp-user-id', // This needs to be properly handled
          platform: 'spotify',
          expiresAt: Date.now() + 10 * 60 * 1000
        }
      } else {
        return res.status(400).json({ error: 'Invalid or expired state' })
      }
    }

    // Clean up state (only if not expo-auth-session)
    if (!isExpoAuthSession) {
      oauthStates.delete(state)
    }

    // Determine redirect URI based on request platform
    let redirectUri = `${FRONTEND_URL}/auth/spotify/callback`; // Default web URI
    
    if (stateData?.requestPlatform === 'ios' || stateData?.requestPlatform === 'android') {
      // For mobile, use the custom circle scheme
      redirectUri = 'circle://auth/spotify/callback';
    }
    
    console.log('🔧 Using redirect URI for token exchange:', redirectUri);

    // Exchange code for access token
    const tokenResponse = await axios.post('https://accounts.spotify.com/api/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
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

    // Get comprehensive Spotify data
    const [topArtistsResponse, topTracksResponse, playlistsResponse, recentlyPlayedResponse] = await Promise.all([
      axios.get('https://api.spotify.com/v1/me/top/artists?limit=10&time_range=medium_term', {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: { items: [] } })),
      axios.get('https://api.spotify.com/v1/me/top/tracks?limit=10&time_range=medium_term', {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: { items: [] } })),
      axios.get('https://api.spotify.com/v1/me/playlists?limit=20', {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: { items: [] } })),
      axios.get('https://api.spotify.com/v1/me/player/recently-played?limit=10', {
        headers: { Authorization: `Bearer ${access_token}` }
      }).catch(() => ({ data: { items: [] } }))
    ])

    // Extract music genres from top artists
    const allGenres = topArtistsResponse.data.items?.flatMap((artist: any) => artist.genres) || []
    const genreCounts = allGenres.reduce((acc: any, genre: string) => {
      acc[genre] = (acc[genre] || 0) + 1
      return acc
    }, {})
    const topGenres = Object.entries(genreCounts)
      .sort(([,a]: any, [,b]: any) => b - a)
      .slice(0, 5)
      .map(([genre]) => genre)

    const platformData = {
      followers: spotifyProfile.followers?.total || 0,
      country: spotifyProfile.country,
      subscription: spotifyProfile.product || 'free',
      top_artists: topArtistsResponse.data.items?.slice(0, 5).map((artist: any) => ({
        name: artist.name,
        genres: artist.genres,
        popularity: artist.popularity,
        image: artist.images?.[0]?.url,
        external_url: artist.external_urls?.spotify
      })) || [],
      top_tracks: topTracksResponse.data.items?.slice(0, 5).map((track: any) => ({
        name: track.name,
        artist: track.artists?.[0]?.name,
        album: track.album?.name,
        popularity: track.popularity,
        preview_url: track.preview_url,
        image: track.album?.images?.[0]?.url,
        external_url: track.external_urls?.spotify
      })) || [],
      top_genres: topGenres,
      playlists_count: playlistsResponse.data.total || 0,
      public_playlists: playlistsResponse.data.items?.filter((p: any) => p.public).slice(0, 5).map((playlist: any) => ({
        name: playlist.name,
        description: playlist.description,
        tracks: playlist.tracks?.total || 0,
        image: playlist.images?.[0]?.url,
        external_url: playlist.external_urls?.spotify
      })) || [],
      recently_played: recentlyPlayedResponse.data.items?.slice(0, 5).map((item: any) => ({
        track: item.track?.name,
        artist: item.track?.artists?.[0]?.name,
        played_at: item.played_at,
        image: item.track?.album?.images?.[0]?.url
      })) || [],
      last_updated: new Date().toISOString()
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

    // Exchange code for access token using Instagram API with Instagram Login
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

    // Get user profile from Instagram API
    const profileResponse = await axios.get(`https://graph.instagram.com/me?fields=id,username,account_type&access_token=${access_token}`)
    const instagramProfile = profileResponse.data

    console.log('📥 Instagram profile data:', instagramProfile);

    const platformData = {
      account_type: instagramProfile.account_type || 'PERSONAL',
      verification_method: 'instagram_api_consumer',
      api_version: 'instagram_api_with_instagram_login',
      verified_at: new Date().toISOString()
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

  } catch (error: any) {
    console.error('❌ Error in Instagram callback:', error)
    console.error('Instagram API error details:', error.response?.data || error.message)
    
    let errorMessage = 'Failed to complete Instagram OAuth'
    if (error.response?.data?.error_description) {
      errorMessage = error.response.data.error_description
    } else if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message
    }
    
    res.status(500).json({ 
      error: errorMessage,
      details: error.response?.data || error.message
    })
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

// Instagram webhook verification endpoint (optional - only if Instagram requires it)
router.get('/webhook/instagram', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']

  // Check if a token and mode were sent
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === 'subscribe' && token === INSTAGRAM_VERIFY_TOKEN) {
      // Respond with 200 OK and challenge token from the request
      console.log('✅ Instagram webhook verified')
      res.status(200).send(challenge)
    } else {
      // Responds with '403 Forbidden' if verify tokens do not match
      console.log('❌ Instagram webhook verification failed')
      res.sendStatus(403)
    }
  } else {
    res.sendStatus(400)
  }
})

// Instagram webhook endpoint (optional - for receiving webhook events)
router.post('/webhook/instagram', (req, res) => {
  console.log('📥 Instagram webhook received:', req.body)
  // Handle Instagram webhook events here if needed
  res.status(200).send('EVENT_RECEIVED')
})

export default router
