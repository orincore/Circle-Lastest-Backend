import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import { getCachedOrFetch, generateCacheKey } from '../services/explore-cache.js'

const router = Router()

// Helper function to get all sections data
async function getAllSectionsLogic(currentUserId: string) {
  console.log('Fetching fresh explore data for user:', currentUserId)
  
  // Get current user's profile for compatibility calculation
  const { data: currentUser, error: currentUserError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', currentUserId)
    .single()

  if (currentUserError) throw currentUserError

  // Get all potential users (increased limit for better distribution)
  const { data: allUsers, error } = await supabase
    .from('profiles')
    .select(`
      id,
      first_name,
      last_name,
      username,
      email,
      profile_photo_url,
      instagram_username,
      age,
      gender,
      interests,
      needs,
      latitude,
      longitude,
      created_at,
      updated_at
    `)
    .neq('id', currentUserId)
    .not('first_name', 'is', null)
    .not('last_name', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(100) // Get more users for better distribution

  if (error) throw error

  // Filter out friends and blocked users
  const userIds = allUsers?.map(u => u.id) || []
  
  // Get friendships to exclude
  const { data: friendships } = await supabase
    .from('friendships')
    .select('user1_id, user2_id')
    .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
    .eq('status', 'active')
    .in('user1_id', [...userIds, currentUserId])
    .in('user2_id', [...userIds, currentUserId])

  // Get blocks to exclude
  const { data: blocks } = await supabase
    .from('blocks')
    .select('blocker_id, blocked_id')
    .or(`blocker_id.eq.${currentUserId},blocked_id.eq.${currentUserId}`)
    .in('blocker_id', [...userIds, currentUserId])
    .in('blocked_id', [...userIds, currentUserId])

  // Create sets of user IDs to exclude
  const friendIds = new Set()
  const blockedIds = new Set()

  friendships?.forEach(f => {
    if (f.user1_id === currentUserId) friendIds.add(f.user2_id)
    if (f.user2_id === currentUserId) friendIds.add(f.user1_id)
  })

  blocks?.forEach(b => {
    blockedIds.add(b.blocker_id)
    blockedIds.add(b.blocked_id)
  })

  // Filter eligible users
  const eligibleUsers = allUsers?.filter(user => 
    !friendIds.has(user.id) && !blockedIds.has(user.id)
  ) || []

  // Calculate scores and categorize users
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const usersWithScores = eligibleUsers.map(user => {
    const compatibilityScore = calculateCompatibilityScore(currentUser, user)
    const isNewUser = new Date(user.created_at) >= sevenDaysAgo
    
    // Calculate profile completeness score
    const completenessScore = (
      (user.first_name ? 1 : 0) +
      (user.last_name ? 1 : 0) +
      (user.profile_photo_url ? 1 : 0) +
      (user.age ? 1 : 0) +
      (user.gender ? 1 : 0) +
      (user.interests && user.interests.length > 0 ? 2 : 0) +
      (user.needs && user.needs.length > 0 ? 2 : 0)
    )

    return {
      id: user.id,
      name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
      username: user.username,
      email: user.email,
      profilePhoto: user.profile_photo_url,
      instagramUsername: user.instagram_username,
      age: user.age,
      gender: user.gender,
      interests: user.interests || [],
      needs: user.needs || [],
      joinedDate: user.created_at,
      isOnline: false,
      compatibilityScore,
      completenessScore,
      isNewUser,
      updatedAt: user.updated_at
    }
  })

  // Smart distribution logic - each user goes to their BEST section
  const distributedUsers = {
    topUsers: [] as any[],
    newUsers: [] as any[],
    compatibleUsers: [] as any[]
  }

  const usedUserIds = new Set()

  // 1. First priority: High compatibility users (score >= 60)
  const highCompatibilityUsers = usersWithScores
    .filter(user => user.compatibilityScore >= 60)
    .sort((a, b) => b.compatibilityScore - a.compatibilityScore)
    .slice(0, 5)

  highCompatibilityUsers.forEach(user => {
    distributedUsers.compatibleUsers.push(user)
    usedUserIds.add(user.id)
  })

  // 2. Second priority: New users (not already in compatibility)
  const availableNewUsers = usersWithScores
    .filter(user => user.isNewUser && !usedUserIds.has(user.id))
    .sort((a, b) => new Date(b.joinedDate).getTime() - new Date(a.joinedDate).getTime())
    .slice(0, 5)

  availableNewUsers.forEach(user => {
    distributedUsers.newUsers.push(user)
    usedUserIds.add(user.id)
  })

  // 3. Third priority: Top users (high completeness, not already used)
  const availableTopUsers = usersWithScores
    .filter(user => !usedUserIds.has(user.id))
    .sort((a, b) => {
      // Sort by completeness score first, then by recent activity
      if (b.completenessScore !== a.completenessScore) {
        return b.completenessScore - a.completenessScore
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
    .slice(0, 5)

  availableTopUsers.forEach(user => {
    distributedUsers.topUsers.push(user)
    usedUserIds.add(user.id)
  })

  console.log('User distribution:', {
    total: usersWithScores.length,
    compatible: distributedUsers.compatibleUsers.length,
    new: distributedUsers.newUsers.length,
    top: distributedUsers.topUsers.length,
    used: usedUserIds.size
  })

  return distributedUsers
}

// Get all explore sections with smart user distribution
router.get('/all-sections', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const cacheKey = generateCacheKey(currentUserId, 'all-sections')
    
    const result = await getCachedOrFetch(cacheKey, async () => {
      return await getAllSectionsLogic(currentUserId)
    })

    res.json(result)
  } catch (error) {
    console.error('Get all explore sections error:', error)
    res.status(500).json({ error: 'Failed to get explore data' })
  }
})

// Keep individual endpoints for backward compatibility
router.get('/top-users', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const cacheKey = generateCacheKey(currentUserId, 'all-sections')
    
    const result = await getCachedOrFetch(cacheKey, async () => {
      // Call the all-sections logic directly instead of HTTP request
      return await getAllSectionsLogic(currentUserId)
    })

    res.json({ users: result.topUsers || [] })
  } catch (error) {
    console.error('Get top users error:', error)
    res.status(500).json({ error: 'Failed to get top users' })
  }
})

// Get newly added users (registered in last 7 days)
router.get('/new-users', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const cacheKey = generateCacheKey(currentUserId, 'all-sections')
    
    const result = await getCachedOrFetch(cacheKey, async () => {
      return await getAllSectionsLogic(currentUserId)
    })

    res.json({ users: result.newUsers || [] })
  } catch (error) {
    console.error('Get new users error:', error)
    res.status(500).json({ error: 'Failed to get new users' })
  }
})

// Get high compatibility users (using matchmaking algorithm)
router.get('/compatible-users', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const cacheKey = generateCacheKey(currentUserId, 'all-sections')
    
    const result = await getCachedOrFetch(cacheKey, async () => {
      return await getAllSectionsLogic(currentUserId)
    })

    res.json({ users: result.compatibleUsers || [] })
  } catch (error) {
    console.error('Get compatible users error:', error)
    res.status(500).json({ error: 'Failed to get compatible users' })
  }
})

// Search users by name, username, or email
router.get('/search', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const { q: query, limit = 20 } = req.query

    if (!query || typeof query !== 'string' || query.trim().length < 2) {
      return res.status(400).json({ error: 'Search query must be at least 2 characters' })
    }

    const searchTerm = query.trim().toLowerCase()

    // Search in multiple fields
    const { data: searchResults, error } = await supabase
      .from('profiles')
      .select(`
        id,
        first_name,
        last_name,
        username,
        email,
        profile_photo_url,
        instagram_username,
        age,
        gender,
        interests,
        needs
      `)
      .neq('id', currentUserId)
      .or(`first_name.ilike.%${searchTerm}%,last_name.ilike.%${searchTerm}%,username.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`)
      .limit(parseInt(limit as string))

    if (error) throw error

    // Filter out blocked users (but include friends in search results)
    const userIds = searchResults?.map(u => u.id) || []
    
    const { data: blocks } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${currentUserId},blocked_id.eq.${currentUserId}`)
      .in('blocker_id', [...userIds, currentUserId])
      .in('blocked_id', [...userIds, currentUserId])

    const blockedIds = new Set()
    blocks?.forEach(b => {
      blockedIds.add(b.blocker_id)
      blockedIds.add(b.blocked_id)
    })

    // Get friendship status for search results
    const { data: friendships } = await supabase
      .from('friendships')
      .select('user1_id, user2_id')
      .or(`user1_id.eq.${currentUserId},user2_id.eq.${currentUserId}`)
      .eq('status', 'active')
      .in('user1_id', [...userIds, currentUserId])
      .in('user2_id', [...userIds, currentUserId])

    const friendIds = new Set()
    friendships?.forEach(f => {
      if (f.user1_id === currentUserId) friendIds.add(f.user2_id)
      if (f.user2_id === currentUserId) friendIds.add(f.user1_id)
    })

    const filteredResults = searchResults
      ?.filter(user => !blockedIds.has(user.id))
      .map(user => ({
        id: user.id,
        name: `${user.first_name || ''} ${user.last_name || ''}`.trim(),
        username: user.username,
        email: user.email,
        profilePhoto: user.profile_photo_url,
        instagramUsername: user.instagram_username,
        age: user.age,
        gender: user.gender,
        interests: user.interests || [],
        needs: user.needs || [],
        isFriend: friendIds.has(user.id),
        isOnline: false
      })) || []

    res.json({ users: filteredResults, query: searchTerm })
  } catch (error) {
    console.error('Search users error:', error)
    res.status(500).json({ error: 'Failed to search users' })
  }
})

// Simple compatibility calculation function
function calculateCompatibilityScore(user1: any, user2: any): number {
  let score = 0

  // Age compatibility (max 20 points)
  if (user1.age && user2.age) {
    const ageDiff = Math.abs(user1.age - user2.age)
    if (ageDiff <= 2) score += 20
    else if (ageDiff <= 5) score += 15
    else if (ageDiff <= 10) score += 10
    else if (ageDiff <= 15) score += 5
  }

  // Interest overlap (max 30 points)
  const user1Interests = user1.interests || []
  const user2Interests = user2.interests || []
  const commonInterests = user1Interests.filter((interest: string) => 
    user2Interests.includes(interest)
  )
  score += Math.min(30, commonInterests.length * 5)

  // Needs compatibility (max 25 points)
  const user1Needs = user1.needs || []
  const user2Needs = user2.needs || []
  const commonNeeds = user1Needs.filter((need: string) => 
    user2Needs.includes(need)
  )
  score += Math.min(25, commonNeeds.length * 8)

  // Location proximity (max 25 points)
  if (user1.latitude && user1.longitude && user2.latitude && user2.longitude) {
    const distance = calculateDistance(
      user1.latitude, user1.longitude,
      user2.latitude, user2.longitude
    )
    if (distance <= 5) score += 25
    else if (distance <= 15) score += 20
    else if (distance <= 50) score += 15
    else if (distance <= 100) score += 10
    else if (distance <= 500) score += 5
  }

  return score
}

// Haversine formula for distance calculation
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371 // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c
}

// Get user profile by ID
router.get('/user/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const { userId } = req.params

    console.log('Getting user profile for userId:', userId)
    console.log('Requested by currentUserId:', currentUserId)

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    // Get user profile
    const { data: userProfile, error } = await supabase
      .from('profiles')
      .select(`
        id,
        first_name,
        last_name,
        username,
        email,
        profile_photo_url,
        instagram_username,
        age,
        gender,
        about,
        interests,
        needs,
        created_at
      `)
      .eq('id', userId)
      .single()

    console.log('Supabase query result:', { userProfile, error })

    if (error) {
      console.error('Error fetching user profile:', error)
      console.error('Error details:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      })
      return res.status(404).json({ error: 'User not found' })
    }
    
    if (!userProfile) {
      console.log('No user profile found for userId:', userId)
      return res.status(404).json({ error: 'User not found' })
    }

    // Check if user is blocked
    const { data: blocks } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`and(blocker_id.eq.${currentUserId},blocked_id.eq.${userId}),and(blocker_id.eq.${userId},blocked_id.eq.${currentUserId})`)

    const isBlocked = blocks && blocks.length > 0

    if (isBlocked) {
      return res.status(403).json({ error: 'User profile not accessible' })
    }

    // Get user stats
    // 1. Count friends
    const { count: friendsCount } = await supabase
      .from('friendships')
      .select('*', { count: 'exact', head: true })
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .eq('status', 'active')

    // 2. Count chats (where user is a participant)
    const { data: userChats } = await supabase
      .from('chat_participants')
      .select('chat_id')
      .eq('user_id', userId)

    const chatIds = userChats?.map(c => c.chat_id) || []
    const chatsCount = chatIds.length

    // 3. Count messages sent
    const { count: messagesSent } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .eq('sender_id', userId)

    // 4. Count messages received (messages in user's chats but not sent by them)
    let messagesReceived = 0
    if (chatIds.length > 0) {
      const { count } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .in('chat_id', chatIds)
        .neq('sender_id', userId)
      messagesReceived = count || 0
    }

    // Transform user data
    const userData = {
      id: userProfile.id,
      name: `${userProfile.first_name || ''} ${userProfile.last_name || ''}`.trim(),
      username: userProfile.username,
      email: userProfile.email,
      profilePhoto: userProfile.profile_photo_url,
      instagramUsername: userProfile.instagram_username,
      age: userProfile.age,
      gender: userProfile.gender,
      about: userProfile.about,
      interests: userProfile.interests || [],
      needs: userProfile.needs || [],
      joinedDate: userProfile.created_at,
      isOnline: false, // TODO: Add online status logic
      stats: {
        friends: friendsCount || 0,
        chats: chatsCount,
        messagesSent: messagesSent || 0,
        messagesReceived: messagesReceived
      }
    }

    console.log('Returning user data:', userData)
    res.json({ user: userData })
  } catch (error) {
    console.error('Get user profile error:', error)
    res.status(500).json({ error: 'Failed to get user profile' })
  }
})

export default router
