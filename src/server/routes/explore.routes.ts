import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { db } from '../config/db.js'
import { blindDateMatches, blocks, chatMembers, exploreInteractions, friendships, matchmakingProposals, messages, profiles } from '../db/schema.js'
import { and, count, eq, gte, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { getCachedOrFetch, generateCacheKey } from '../services/explore-cache.js'
import { cache, cacheKeys, PROFILE_TTL } from '../services/cache.js'

const router = Router()

// Helper function to get all sections data
async function getAllSectionsLogic(currentUserId: string) {
  //console.log('Fetching fresh explore data for user:', currentUserId)
  
  // Get current user's profile for compatibility calculation
  const [currentUser] = await db.select().from(profiles).where(eq(profiles.id, currentUserId)).limit(1)

  if (!currentUser) throw new Error('Current user profile not found')

  // Check if current user is in invisible mode
  if (currentUser.invisibleMode) {
    return {
      topUsers: [],
      newUsers: [],
      compatibleUsers: [],
      message: 'Explore is disabled while in invisible mode. Turn off invisible mode in settings to use this feature.'
    }
  }

  // Get all potential users (increased limit for better distribution) - show all users regardless of verification
  const allUsersRows = await db.select({
    id: profiles.id,
    first_name: profiles.firstName,
    last_name: profiles.lastName,
    username: profiles.username,
    email: profiles.email,
    profile_photo_url: profiles.profilePhotoUrl,
    instagram_username: profiles.instagramUsername,
    age: profiles.age,
    gender: profiles.gender,
    interests: profiles.interests,
    needs: profiles.needs,
    latitude: profiles.latitude,
    longitude: profiles.longitude,
    created_at: profiles.createdAt,
    updated_at: profiles.updatedAt,
    invisible_mode: profiles.invisibleMode,
    verification_status: profiles.verificationStatus,
    email_verified: profiles.emailVerified,
  })
    .from(profiles)
    .where(and(
      ne(profiles.id, currentUserId),
      sql`${profiles.firstName} is not null`,
      sql`${profiles.lastName} is not null`,
      ne(profiles.invisibleMode, true),
      isNull(profiles.deletedAt),
      or(isNull(profiles.isSuspended), eq(profiles.isSuspended, false)),
    ))
    .orderBy(sql`${profiles.updatedAt} desc`)
    .limit(100)

  const allUsers = allUsersRows

  // Filter out friends and blocked users
  const userIds = allUsers?.map(u => u.id) || []

  // Get friendships to exclude (accept both 'active' and 'accepted')
  const friendshipRows = userIds.length > 0 ? await db.select({
    user1_id: friendships.user1Id,
    user2_id: friendships.user2Id,
  })
    .from(friendships)
    .where(and(
      or(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, currentUserId)),
      inArray(friendships.status, ['active', 'accepted']),
      inArray(friendships.user1Id, [...userIds, currentUserId]),
      inArray(friendships.user2Id, [...userIds, currentUserId]),
    )) : []

  // Get blocks to exclude
  const blockRows = userIds.length > 0 ? await db.select({
    blocker_id: blocks.blockerId,
    blocked_id: blocks.blockedId,
  })
    .from(blocks)
    .where(and(
      or(eq(blocks.blockerId, currentUserId), eq(blocks.blockedId, currentUserId)),
      inArray(blocks.blockerId, [...userIds, currentUserId]),
      inArray(blocks.blockedId, [...userIds, currentUserId]),
    )) : []

  // Create sets of user IDs to exclude
  const friendIds = new Set<string>()
  const blockedIds = new Set<string>()

  friendshipRows?.forEach(f => {
    if (f.user1_id === currentUserId) friendIds.add(f.user2_id)
    if (f.user2_id === currentUserId) friendIds.add(f.user1_id)
  })

  blockRows?.forEach(b => {
    blockedIds.add(b.blocker_id)
    blockedIds.add(b.blocked_id)
  })

  // Also exclude users who are currently in an ACTIVE blind date match with the current user.
  // Once a blind date is revealed, they can appear normally in explore/search.
  const blindMatchRows = await db.select({
    user_a: blindDateMatches.userA,
    user_b: blindDateMatches.userB,
    status: blindDateMatches.status,
  })
    .from(blindDateMatches)
    .where(and(
      or(eq(blindDateMatches.userA, currentUserId), eq(blindDateMatches.userB, currentUserId)),
      eq(blindDateMatches.status, 'active'),
    ))

  const blindPartnerIds = new Set<string>()
  blindMatchRows?.forEach((m: any) => {
    const otherId = m.user_a === currentUserId ? m.user_b : m.user_a
    if (otherId) blindPartnerIds.add(otherId)
  })

  // Get current user's preferences for filtering
  const userNeeds = currentUser.needs || []
  const userInterests = currentUser.interests || []
  const userAgePreference = currentUser.agePreference || 'flexible'
  const userLocationPreference = currentUser.locationPreference || 'nearby'
  
  // Calculate age range based on preference
  const getAgeRange = (preference: string, userAge: number) => {
    switch (preference) {
      case 'younger': return [Math.max(18, userAge - 10), userAge]
      case 'older': return [userAge, userAge + 10]
      case 'similar': return [userAge - 5, userAge + 5]
      case 'flexible':
      default: return [18, 100]
    }
  }
  
  const [minAge, maxAge] = getAgeRange(userAgePreference, currentUser.age || 25)
  
  // Filter eligible users based on preferences
  const eligibleUsers = allUsers?.filter(user => {
    // Basic filters
    if (friendIds.has(user.id) || blockedIds.has(user.id) || blindPartnerIds.has(user.id)) {
      return false
    }
    
    // Age preference filter
    if (user.age && (user.age < minAge || user.age > maxAge)) {
      return false
    }
    
    // Needs matching - at least one common need
    const userNeedsLower = userNeeds.map((n: string) => n.toLowerCase())
    const candidateNeeds = (user.needs || []).map((n: string) => n.toLowerCase())
    const hasCommonNeed = userNeedsLower.length === 0 || candidateNeeds.length === 0 || 
      userNeedsLower.some((need: string) => candidateNeeds.includes(need))
    
    if (!hasCommonNeed) {
      return false
    }
    
    // Location preference filter (if user has location data)
    if (currentUser.latitude && currentUser.longitude && user.latitude && user.longitude) {
      const distance = calculateDistance(
        Number(currentUser.latitude), Number(currentUser.longitude),
        Number(user.latitude), Number(user.longitude)
      )
      
      // Apply location preference
      if (userLocationPreference === 'nearby' && distance > 50) {
        return false
      } else if (userLocationPreference === 'same_city' && distance > 100) {
        return false
      }
      // 'flexible' and 'international' allow all distances
    }
    
    return true
  }) || []

  // Calculate scores and categorize users
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  const usersWithScores = eligibleUsers.map(user => {
    const compatibilityScore = calculateCompatibilityScore(currentUser, user)
    const isNewUser = new Date(user.created_at as string) >= sevenDaysAgo
    
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
      isFriend: false, // Already filtered out friends, so this is always false
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
    .sort((a, b) => new Date(b.joinedDate as string).getTime() - new Date(a.joinedDate as string).getTime())
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
      return new Date(b.updatedAt as string).getTime() - new Date(a.updatedAt as string).getTime()
    })
    .slice(0, 5)

  availableTopUsers.forEach(user => {
    distributedUsers.topUsers.push(user)
    usedUserIds.add(user.id)
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

    // Search in multiple fields - show all users regardless of verification status
    const searchResults = await db.select({
      id: profiles.id,
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      username: profiles.username,
      email: profiles.email,
      profile_photo_url: profiles.profilePhotoUrl,
      instagram_username: profiles.instagramUsername,
      age: profiles.age,
      gender: profiles.gender,
      interests: profiles.interests,
      needs: profiles.needs,
      verification_status: profiles.verificationStatus,
      email_verified: profiles.emailVerified,
    })
      .from(profiles)
      .where(and(
        ne(profiles.id, currentUserId),
        isNull(profiles.deletedAt),
        or(isNull(profiles.isSuspended), eq(profiles.isSuspended, false)),
        or(
          ilike(profiles.firstName, `%${searchTerm}%`),
          ilike(profiles.lastName, `%${searchTerm}%`),
          ilike(profiles.username, `%${searchTerm}%`),
          ilike(profiles.email, `%${searchTerm}%`),
        ),
      ))
      .limit(parseInt(limit as string))

    // Filter out blocked users (but include friends in search results)
    const userIds = searchResults?.map(u => u.id) || []

    const blockRows = userIds.length > 0 ? await db.select({
      blocker_id: blocks.blockerId,
      blocked_id: blocks.blockedId,
    })
      .from(blocks)
      .where(and(
        or(eq(blocks.blockerId, currentUserId), eq(blocks.blockedId, currentUserId)),
        inArray(blocks.blockerId, [...userIds, currentUserId]),
        inArray(blocks.blockedId, [...userIds, currentUserId]),
      )) : []

    const blockedIds = new Set()
    blockRows?.forEach(b => {
      blockedIds.add(b.blocker_id)
      blockedIds.add(b.blocked_id)
    })

    // Get friendship status for search results (accept both 'active' and 'accepted')
    const friendshipRows = userIds.length > 0 ? await db.select({
      user1_id: friendships.user1Id,
      user2_id: friendships.user2Id,
    })
      .from(friendships)
      .where(and(
        or(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, currentUserId)),
        inArray(friendships.status, ['active', 'accepted']),
        inArray(friendships.user1Id, [...userIds, currentUserId]),
        inArray(friendships.user2Id, [...userIds, currentUserId]),
      )) : []

    const friendIds = new Set()
    friendshipRows?.forEach(f => {
      if (f.user1_id === currentUserId) friendIds.add(f.user2_id)
      if (f.user2_id === currentUserId) friendIds.add(f.user1_id)
    })

    // Exclude users who are in an ACTIVE blind date match with the current user
    const blindMatchRows = await db.select({
      user_a: blindDateMatches.userA,
      user_b: blindDateMatches.userB,
      status: blindDateMatches.status,
    })
      .from(blindDateMatches)
      .where(and(
        or(eq(blindDateMatches.userA, currentUserId), eq(blindDateMatches.userB, currentUserId)),
        eq(blindDateMatches.status, 'active'),
      ))

    const blindPartnerIds = new Set<string>()
    blindMatchRows?.forEach((m: any) => {
      const otherId = m.user_a === currentUserId ? m.user_b : m.user_a
      if (otherId) blindPartnerIds.add(otherId)
    })

    const filteredResults = searchResults
      ?.filter(user => !blockedIds.has(user.id) && !blindPartnerIds.has(user.id))
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
      Number(user1.latitude), Number(user1.longitude),
      Number(user2.latitude), Number(user2.longitude)
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

    //console.log('Getting user profile for userId:', userId)
    //console.log('Requested by currentUserId:', currentUserId)

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    // Block check first — it's viewer-specific (depends on currentUserId), so it
    // must run on every request and can't be part of the shared cached payload.
    const blockRows = await db.select({
      blocker_id: blocks.blockerId,
      blocked_id: blocks.blockedId,
    })
      .from(blocks)
      .where(or(
        and(eq(blocks.blockerId, currentUserId), eq(blocks.blockedId, userId)),
        and(eq(blocks.blockerId, userId), eq(blocks.blockedId, currentUserId)),
      ))

    const isBlocked = blockRows && blockRows.length > 0

    if (isBlocked) {
      return res.status(403).json({ error: 'User profile not accessible' })
    }

    // The profile payload below (profile fields + stats) depends only on the
    // target user, not the viewer, so it can be cached and shared across viewers.
    const cacheKey = cacheKeys.profileView(userId)
    const cachedUser = await cache.getJSON(cacheKey)
    if (cachedUser) {
      return res.json({ user: cachedUser })
    }

    // Get user profile
    let userProfile
    try {
      const [row] = await db.select({
        id: profiles.id,
        first_name: profiles.firstName,
        last_name: profiles.lastName,
        username: profiles.username,
        email: profiles.email,
        profile_photo_url: profiles.profilePhotoUrl,
        instagram_username: profiles.instagramUsername,
        age: profiles.age,
        gender: profiles.gender,
        about: profiles.about,
        interests: profiles.interests,
        needs: profiles.needs,
        created_at: profiles.createdAt,
        verification_status: profiles.verificationStatus,
        email_verified: profiles.emailVerified,
        is_suspended: profiles.isSuspended,
        deleted_at: profiles.deletedAt,
      })
        .from(profiles)
        .where(eq(profiles.id, userId))
        .limit(1)
      userProfile = row
    } catch (error) {
      console.error('Error fetching user profile:', error)
      return res.status(404).json({ error: 'User not found' })
    }

    if (!userProfile) {
      //console.log('No user profile found for userId:', userId)
      return res.status(404).json({ error: 'User not found' })
    }

    // Check if user is suspended or deleted
    if (userProfile.deleted_at || userProfile.is_suspended) {
      return res.status(404).json({ error: 'User not found' })
    }

    // Get user stats
    // 1. Count friends (accept both 'active' and 'accepted')
    const [{ count: friendsCount }] = await db.select({ count: count() })
      .from(friendships)
      .where(and(
        or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
        inArray(friendships.status, ['active', 'accepted']),
      ))

    // 2. Count chats (where user is a participant)
    const userChats = await db.select({ chat_id: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId))

    const chatIds = userChats?.map(c => c.chat_id) || []
    const chatsCount = chatIds.length

    // 3. Count messages sent
    const [{ count: messagesSent }] = await db.select({ count: count() })
      .from(messages)
      .where(eq(messages.senderId, userId))

    // 4. Count messages received (messages in user's chats but not sent by them)
    let messagesReceived = 0
    if (chatIds.length > 0) {
      const [{ count: recvCount }] = await db.select({ count: count() })
        .from(messages)
        .where(and(inArray(messages.chatId, chatIds), ne(messages.senderId, userId)))
      messagesReceived = recvCount || 0
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

    // Cache the viewer-independent payload (invalidated on profile/friend changes).
    await cache.setJSON(cacheKey, userData, PROFILE_TTL.view)

    //console.log('Returning user data:', userData)
    res.json({ user: userData })
  } catch (error) {
    console.error('Get user profile error:', error)
    res.status(500).json({ error: 'Failed to get user profile' })
  }
})

// Quick match from explore page
router.post('/match', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const { targetUserId, actionType } = req.body // 'like', 'super_like', 'pass'

    if (!targetUserId) {
      return res.status(400).json({ error: 'Target user ID is required' })
    }

    if (currentUserId === targetUserId) {
      return res.status(400).json({ error: 'Cannot match with yourself' })
    }

    if (!['like', 'super_like', 'pass'].includes(actionType)) {
      return res.status(400).json({ error: 'Invalid action type' })
    }

    // Check if already matched
    const [existingFriendship] = await db.select({
      id: friendships.id,
      status: friendships.status,
    })
      .from(friendships)
      .where(and(
        or(
          and(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, targetUserId)),
          and(eq(friendships.user1Id, targetUserId), eq(friendships.user2Id, currentUserId)),
        ),
        inArray(friendships.status, ['active', 'accepted', 'pending']),
      ))
      .limit(1)

    if (existingFriendship) {
      return res.json({
        matchStatus: existingFriendship.status === 'pending' ? 'pending' : 'matched',
        message: existingFriendship.status === 'pending' ? 'Match request already sent' : 'Already matched with this user'
      })
    }

    // Track explore interaction
    await db.insert(exploreInteractions).values({
      userId: currentUserId,
      targetUserId: targetUserId,
      actionType: actionType,
      interactionSource: 'explore',
    })

    if (actionType === 'pass') {
      return res.json({
        matchStatus: 'passed',
        message: 'User passed'
      })
    }

    // Check if target user has already liked current user (mutual match)
    const [reverseProposal] = await db.select({ id: matchmakingProposals.id })
      .from(matchmakingProposals)
      .where(and(
        eq(matchmakingProposals.a, targetUserId),
        eq(matchmakingProposals.b, currentUserId),
        eq(matchmakingProposals.status, 'pending'),
      ))
      .limit(1)

    if (reverseProposal) {
      // Mutual match! Create friendship
      let newFriendship
      try {
        const [row] = await db.insert(friendships).values({
          user1Id: currentUserId,
          user2Id: targetUserId,
          status: 'accepted',
        }).returning()
        newFriendship = row
      } catch (friendshipError) {
        console.error('Error creating friendship:', friendshipError)
        return res.status(500).json({ error: 'Failed to create match' })
      }

      // Update both proposals to matched
      await db.update(matchmakingProposals)
        .set({ status: 'matched' })
        .where(eq(matchmakingProposals.id, reverseProposal.id))

      // Send notifications
      const io = req.app.get('io')
      if (io) {
        io.to(targetUserId).emit('match:new', {
          userId: currentUserId,
          matchId: newFriendship.id
        })
        io.to(currentUserId).emit('match:new', {
          userId: targetUserId,
          matchId: newFriendship.id
        })
      }

      return res.json({
        matchStatus: 'matched',
        message: "It's a Match! 🎉",
        friendshipId: newFriendship.id
      })
    }

    // Create new match proposal
    let newProposal
    try {
      const [row] = await db.insert(matchmakingProposals).values({
        a: currentUserId,
        b: targetUserId,
        status: 'pending',
        type: actionType === 'super_like' ? 'super_like' : 'like',
      }).returning()
      newProposal = row
    } catch (proposalError) {
      console.error('Error creating proposal:', proposalError)
      return res.status(500).json({ error: 'Failed to send match request' })
    }

    // Send notification to target user
    const io = req.app.get('io')
    if (io) {
      io.to(targetUserId).emit('match:request', {
        senderId: currentUserId,
        type: actionType,
        proposalId: newProposal.id
      })
    }

    res.json({
      matchStatus: 'pending',
      message: actionType === 'super_like' ? 'Super Like sent! ⭐' : 'Match request sent ✓',
      proposalId: newProposal.id
    })
  } catch (error) {
    console.error('Explore match error:', error)
    res.status(500).json({ error: 'Failed to process match action' })
  }
})

// Check match status with a specific user
router.get('/match-status/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const { userId: targetUserId } = req.params

    if (!targetUserId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    // Check friendship status
    const [friendship] = await db.select({
      id: friendships.id,
      status: friendships.status,
    })
      .from(friendships)
      .where(or(
        and(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, targetUserId)),
        and(eq(friendships.user1Id, targetUserId), eq(friendships.user2Id, currentUserId)),
      ))
      .limit(1)

    if (friendship) {
      return res.json({
        status: friendship.status === 'pending' ? 'pending' : 'matched'
      })
    }

    // Check if there's a pending proposal
    const [proposal] = await db.select({
      id: matchmakingProposals.id,
      type: matchmakingProposals.type,
    })
      .from(matchmakingProposals)
      .where(and(
        or(
          and(eq(matchmakingProposals.a, currentUserId), eq(matchmakingProposals.b, targetUserId)),
          and(eq(matchmakingProposals.a, targetUserId), eq(matchmakingProposals.b, currentUserId)),
        ),
        eq(matchmakingProposals.status, 'pending'),
      ))
      .limit(1)

    if (proposal) {
      return res.json({
        status: 'pending',
        type: proposal.type
      })
    }

    res.json({ status: 'none' })
  } catch (error) {
    console.error('Match status check error:', error)
    res.status(500).json({ error: 'Failed to check match status' })
  }
})

// Undo pass action
router.post('/undo-pass', requireAuth, async (req: AuthRequest, res) => {
  try {
    const currentUserId = req.user!.id
    const { targetUserId } = req.body

    if (!targetUserId) {
      return res.status(400).json({ error: 'Target user ID is required' })
    }

    // Delete the pass interaction from last 24 hours
    const oneDayAgo = new Date()
    oneDayAgo.setDate(oneDayAgo.getDate() - 1)

    try {
      await db.delete(exploreInteractions).where(and(
        eq(exploreInteractions.userId, currentUserId),
        eq(exploreInteractions.targetUserId, targetUserId),
        eq(exploreInteractions.actionType, 'pass'),
        gte(exploreInteractions.createdAt, oneDayAgo.toISOString()),
      ))
    } catch (error) {
      console.error('Error undoing pass:', error)
      return res.status(500).json({ error: 'Failed to undo pass' })
    }

    res.json({ 
      success: true,
      message: 'Pass action undone successfully'
    })
  } catch (error) {
    console.error('Undo pass error:', error)
    res.status(500).json({ error: 'Failed to undo pass' })
  }
})

export default router
