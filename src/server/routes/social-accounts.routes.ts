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

// Start Instagram OAuth flow via Facebook Login (Instagram API with Instagram Login)
router.post('/link/instagram', requireAuth, async (req: AuthRequest, res) => {
  try {
    if (!INSTAGRAM_CLIENT_ID) {
      return res.status(500).json({ error: 'Instagram OAuth not configured' })
    }

    console.log('🔍 Instagram (FB Login) OAuth Debug:');
    console.log('- FB App ID exists:', !!INSTAGRAM_CLIENT_ID);
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

    // Facebook Login authorization endpoint (Instagram API with Instagram Login)
    // Scopes to discover pages and the connected Instagram business account
    // pages_show_list: list pages
    // pages_manage_metadata: allows reading page access_token
    // pages_read_engagement: safer read of page fields
    // instagram_basic: basic IG profile once IG user is discovered
    const scopes = ['pages_show_list', 'pages_manage_metadata', 'pages_read_engagement', 'instagram_basic'].join(',')

    const authUrl = `https://www.facebook.com/v19.0/dialog/oauth?` +
      `client_id=${encodeURIComponent(INSTAGRAM_CLIENT_ID)}&` +
      `redirect_uri=${encodeURIComponent(`${FRONTEND_URL}/auth/instagram/callback`)}&` +
      `scope=${encodeURIComponent(scopes)}&` +
      `response_type=code&` +
      `state=${encodeURIComponent(state)}`

    console.log('✅ Generated Facebook Login URL for Instagram linking:', authUrl);
    res.json({ authUrl, state })
  } catch (error: any) {
    console.error('❌ Error starting Instagram OAuth (FB Login):', error)
    console.error('Error details:', error.response?.data || error.message)
    res.status(500).json({ 
      error: 'Failed to start Instagram OAuth',
      details: error.response?.data || error.message
    })
  }
})

// Handle Spotify OAuth callback
router.post('/callback/spotify', async (req, res) => {
  console.log('🎵 Spotify callback endpoint hit!');
  try {
    const { code, state, error: oauthError } = req.body

    console.log('🔧 Spotify callback received:', { code: code ? 'present' : 'missing', state, error: oauthError })

    if (oauthError) {
      return res.status(400).json({ error: `OAuth error: ${oauthError}` })
    }

    if (!code || !state) {
      return res.status(400).json({ error: 'Missing code or state parameter' })
    }

    // For expo-auth-session, we need to identify the user differently
    // Since expo-auth-session generates its own state, we'll use the authorization header
    const authHeader = req.headers.authorization
    console.log('🔧 Auth header present:', !!authHeader)
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('❌ Missing or invalid authorization header')
      return res.status(401).json({ error: 'Authorization token required' })
    }
    
    const token = authHeader.substring(7)
    
    // Verify the JWT token to get user ID
    let userId
    try {
      const jwt = await import('jsonwebtoken')
      console.log('🔧 JWT_SECRET available:', !!process.env.JWT_SECRET)
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret') as any
      userId = decoded.userId || decoded.id
      console.log('✅ Identified user from token:', userId)
      console.log('🔧 Decoded token:', { userId: decoded.userId, id: decoded.id })
    } catch (error: any) {
      console.error('❌ Invalid token:', error)
      console.error('❌ Token verification failed:', error.message)
      return res.status(401).json({ error: 'Invalid authorization token' })
    }
    
    // Create state data for expo-auth-session
    const stateData = {
      userId,
      platform: 'spotify',
      requestPlatform: 'ios', // Assume mobile for expo-auth-session
      expiresAt: Date.now() + 10 * 60 * 1000
    }
    
    console.log('🔧 Using expo-auth-session flow for user:', userId)
    console.log('🔧 State data created:', stateData)

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

// Handle Instagram OAuth callback (Facebook Login -> Graph API)
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

    // Exchange code for a Facebook User Access Token
    const tokenExchangeUrl = 'https://graph.facebook.com/v19.0/oauth/access_token'
    const tokenResponse = await axios.get(tokenExchangeUrl, {
      params: {
        client_id: INSTAGRAM_CLIENT_ID,
        client_secret: INSTAGRAM_CLIENT_SECRET,
        redirect_uri: `${FRONTEND_URL}/auth/instagram/callback`,
        code
      }
    })

    const { access_token } = tokenResponse.data

    // 1) Fetch pages this user manages
    const pagesResponse = await axios.get('https://graph.facebook.com/v19.0/me/accounts', {
      params: { access_token }
    })

    const pages: Array<{ id: string; name?: string; access_token?: string }> = pagesResponse.data?.data || []
    if (!pages.length) {
      return res.status(400).json({
        error: 'No Facebook Pages found on this account',
        details: 'Your Facebook account must manage a Page that is connected to an Instagram Professional account.'
      })
    }

    // 2) Find a page with an attached instagram_business_account
    let igUserId: string | null = null
    let pageAccessToken: string | null = null
    for (const page of pages) {
      try {
        let tokenToUse = page.access_token || access_token
        // If page access token is missing, try to fetch it explicitly
        if (!page.access_token) {
          try {
            const pageTokenResp = await axios.get(`https://graph.facebook.com/v19.0/${page.id}`, {
              params: {
                fields: 'access_token',
                access_token
              }
            })
            if (pageTokenResp.data?.access_token) {
              tokenToUse = pageTokenResp.data.access_token
            }
          } catch (e) {
            // ignore and continue with user token (may still work if permissions allow)
          }
        }
        const pageDetailResp = await axios.get(`https://graph.facebook.com/v19.0/${page.id}`, {
          params: {
            fields: 'instagram_business_account',
            access_token: tokenToUse
          }
        })
        const ig = pageDetailResp.data?.instagram_business_account
        if (ig?.id) {
          igUserId = ig.id
          pageAccessToken = tokenToUse
          break
        }
      } catch (e) {
        // ignore and try next page
      }
    }

    if (!igUserId) {
      return res.status(400).json({
        error: 'No connected Instagram Business account found',
        details: 'Connect your Instagram Professional account to a Facebook Page and try again.'
      })
    }

    // 3) Fetch Instagram user profile
    const igProfileResp = await axios.get(`https://graph.facebook.com/v19.0/${igUserId}`, {
      params: {
        fields: 'username,ig_id,account_type',
        access_token: pageAccessToken || access_token
      }
    })

    const igProfile = igProfileResp.data || {}
    if (!igProfile?.username) {
      return res.status(500).json({ error: 'Failed to fetch Instagram profile username' })
    }

    const platformData = {
      account_type: igProfile.account_type || 'BUSINESS',
      verification_method: 'instagram_api_business',
      api_version: 'instagram_api_with_instagram_login',
      verified_at: new Date().toISOString()
    }

    // Store in database
    const { error: dbError } = await supabase
      .from('linked_social_accounts')
      .upsert({
        user_id: stateData.userId,
        platform: 'instagram',
        platform_user_id: igProfile.ig_id || igUserId,
        platform_username: igProfile.username,
        platform_display_name: igProfile.username,
        platform_profile_url: `https://instagram.com/${igProfile.username}`,
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
        username: igProfile.username,
        profile_url: `https://instagram.com/${igProfile.username}`
      }
    })

  } catch (error: any) {
    console.error('❌ Error in Instagram callback (FB Login flow):', error)
    console.error('Graph API error details:', error.response?.data || error.message)
    
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

// Instagram deauthorize callback (required for Facebook App)
router.post('/webhook/instagram/deauth', (req, res) => {
  try {
    console.log('📥 Instagram deauthorize callback received:', req.body)
    
    const { signed_request } = req.body
    
    if (signed_request) {
      // Parse the signed request to get user ID
      // In production, you should verify the signature
      const payload = signed_request.split('.')[1]
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString())
      
      console.log('User deauthorized Instagram access:', decoded.user_id)
      
      // Optional: Mark the user's Instagram account as deauthorized in your database
      // This is useful for compliance and user privacy
    }
    
    res.status(200).json({ success: true })
  } catch (error) {
    console.error('Error handling Instagram deauthorize:', error)
    res.status(200).json({ success: true }) // Always return 200 for webhooks
  }
})

// Instagram data deletion request callback (required for Facebook App)
router.post('/webhook/instagram/deletion', (req, res) => {
  try {
    console.log('📥 Instagram data deletion request received:', req.body)
    
    const { signed_request } = req.body
    
    if (signed_request) {
      // Parse the signed request to get user ID
      const payload = signed_request.split('.')[1]
      const decoded = JSON.parse(Buffer.from(payload, 'base64').toString())
      
      console.log('User requested data deletion for Instagram:', decoded.user_id)
      
      // Generate a confirmation code for the deletion request
      const confirmationCode = `DEL_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      // In production, you should:
      // 1. Queue the user's data for deletion
      // 2. Store the confirmation code
      // 3. Actually delete the data within the required timeframe
      
      console.log('Generated deletion confirmation code:', confirmationCode)
      
      // Return the confirmation code and deletion URL
      res.status(200).json({
        url: `${process.env.FRONTEND_URL || 'https://circle.orincore.com'}/data-deletion/${confirmationCode}`,
        confirmation_code: confirmationCode
      })
    } else {
      res.status(200).json({ success: true })
    }
  } catch (error) {
    console.error('Error handling Instagram data deletion request:', error)
    res.status(200).json({ success: true }) // Always return 200 for webhooks
  }
})

export default router
