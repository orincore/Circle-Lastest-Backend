import Redis from 'ioredis'
import { findById, type Profile } from '../repos/profiles.repo.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { supabase } from '../config/supabase.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { logger } from '../config/logger.js'
import { CirclePointsService } from './circle-points.service.js'
import { NotificationService } from './notificationService.js'
import { trackUserMatched, trackChatStarted } from './activityService.js'
import { CompatibilityService } from './compatibility.service.js'

// Redis client for distributed state management
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

// Redis keys
const KEYS = {
  SEARCHING_QUEUE: 'matchmaking:searching',
  PROPOSALS: 'matchmaking:proposals',
  COOLDOWNS: 'matchmaking:cooldowns',
  USER_CACHE: 'matchmaking:users',
  GEOSPATIAL: 'matchmaking:geo',
  RATE_LIMIT: 'matchmaking:rate_limit',
  METRICS: 'matchmaking:metrics'
}

// Constants for optimization
const PROPOSAL_EXPIRY = 90_000 // 90 seconds
const COOLDOWN_DURATION = 60_000 // 60 seconds
const USER_CACHE_TTL = 300 // 5 minutes
const MAX_SEARCH_RADIUS = 50 // km
const BATCH_SIZE = 100 // Process users in batches
const RATE_LIMIT_WINDOW = 60 // seconds
const RATE_LIMIT_MAX_REQUESTS = 10

type UserId = string
type ProposalId = string

interface SearchState {
  userId: UserId
  startedAt: number
  latitude?: number
  longitude?: number
  preferences: {
    maxDistance?: number
    ageRange?: [number, number]
    interests?: string[]
    needs?: string[]
  }
}

interface Proposal {
  id: ProposalId
  a: UserId
  b: UserId
  createdAt: number
  expiresAt: number
  acceptedA: boolean
  acceptedB: boolean
  cancelled: boolean
  type?: string // 'message_request' or undefined for regular matches
}

interface CachedProfile extends Profile {
  cachedAt: number
}

// Rate limiting helper
async function checkRateLimit(userId: string): Promise<boolean> {
  const key = `${KEYS.RATE_LIMIT}:${userId}`
  const current = await redis.incr(key)
  if (current === 1) {
    await redis.expire(key, RATE_LIMIT_WINDOW)
  }
  return current <= RATE_LIMIT_MAX_REQUESTS
}

// User profile caching with Redis
async function getCachedProfile(userId: string): Promise<CachedProfile | null> {
  try {
    const cached = await redis.get(`${KEYS.USER_CACHE}:${userId}`)
    if (cached) {
      const profile = JSON.parse(cached) as CachedProfile
      // Check if cache is still valid
      if (Date.now() - profile.cachedAt < USER_CACHE_TTL * 1000) {
        return profile
      }
    }
    
    // Fetch from database and cache
    const profile = await findById(userId)
    if (profile) {
      const cachedProfile: CachedProfile = { ...profile, cachedAt: Date.now() }
      await redis.setex(`${KEYS.USER_CACHE}:${userId}`, USER_CACHE_TTL, JSON.stringify(cachedProfile))
      return cachedProfile
    }
    return null
  } catch (error) {
    logger.error({ error, userId }, 'Failed to get cached profile')
    const profile = await findById(userId)
    return profile ? { ...profile, cachedAt: Date.now() } : null // Fallback to direct DB query
  }
}

// Geospatial indexing for location-based matching
async function addToGeospatialIndex(userId: string, latitude: number, longitude: number): Promise<void> {
  try {
    await redis.geoadd(KEYS.GEOSPATIAL, longitude, latitude, userId)
  } catch (error) {
    logger.error({ error, userId }, 'Failed to add to geospatial index')
  }
}

async function findNearbyUsers(userId: string, latitude: number, longitude: number, radius: number = MAX_SEARCH_RADIUS): Promise<string[]> {
  try {
    const nearby = await redis.georadius(
      KEYS.GEOSPATIAL,
      longitude,
      latitude,
      radius,
      'km',
      'WITHDIST',
      'ASC',
      'COUNT',
      BATCH_SIZE
    )
    
    return nearby
      .filter((item: any) => item[0] !== userId) // Exclude self
      .map((item: any) => item[0]) // Extract user IDs
  } catch (error) {
    logger.error({ error, userId }, 'Failed to find nearby users')
    return []
  }
}

// Distributed queue management
async function addToSearchQueue(searchState: SearchState): Promise<void> {
  try {
    const score = Date.now() // Use timestamp as score for FIFO ordering
    await redis.zadd(KEYS.SEARCHING_QUEUE, score, JSON.stringify(searchState))
    
    // Add to geospatial index if location provided
    if (searchState.latitude && searchState.longitude) {
      await addToGeospatialIndex(searchState.userId, searchState.latitude, searchState.longitude)
    }
    
    logger.info({ userId: searchState.userId }, 'Added user to search queue')
  } catch (error) {
    logger.error({ error, userId: searchState.userId }, 'Failed to add to search queue')
  }
}

async function removeFromSearchQueue(userId: string): Promise<void> {
  try {
    // Remove from sorted set (need to find and remove by value)
    const members = await redis.zrange(KEYS.SEARCHING_QUEUE, 0, -1)
    for (const member of members) {
      const searchState = JSON.parse(member) as SearchState
      if (searchState.userId === userId) {
        await redis.zrem(KEYS.SEARCHING_QUEUE, member)
        break
      }
    }
    
    // Remove from geospatial index
    await redis.zrem(KEYS.GEOSPATIAL, userId)
    
    logger.info({ userId }, 'Removed user from search queue')
  } catch (error) {
    logger.error({ error, userId }, 'Failed to remove from search queue')
  }
}

async function getSearchingUsers(limit: number = BATCH_SIZE): Promise<SearchState[]> {
  try {
    const members = await redis.zrange(KEYS.SEARCHING_QUEUE, 0, limit - 1)
    return members.map(member => JSON.parse(member) as SearchState)
  } catch (error) {
    logger.error({ error }, 'Failed to get searching users')
    return []
  }
}

// Proposal management with Redis
async function createProposal(userId: string, otherId: string): Promise<Proposal> {
  const id = `${userId.slice(0, 6)}_${otherId.slice(0, 6)}_${Date.now()}`
  const proposal: Proposal = {
    id,
    a: userId,
    b: otherId,
    createdAt: Date.now(),
    expiresAt: Date.now() + PROPOSAL_EXPIRY,
    acceptedA: false,
    acceptedB: false,
    cancelled: false,
  }
  
  try {
    await redis.setex(`${KEYS.PROPOSALS}:${id}`, Math.ceil(PROPOSAL_EXPIRY / 1000), JSON.stringify(proposal))
    logger.info({ proposalId: id, userA: userId, userB: otherId }, 'Created proposal')
    return proposal
  } catch (error) {
    logger.error({ error, proposalId: id }, 'Failed to create proposal')
    throw error
  }
}

async function getProposal(proposalId: string): Promise<Proposal | null> {
  try {
    const data = await redis.get(`${KEYS.PROPOSALS}:${proposalId}`)
    return data ? JSON.parse(data) as Proposal : null
  } catch (error) {
    logger.error({ error, proposalId }, 'Failed to get proposal')
    return null
  }
}

async function updateProposal(proposal: Proposal): Promise<void> {
  try {
    const ttl = Math.max(1, Math.ceil((proposal.expiresAt - Date.now()) / 1000))
    await redis.setex(`${KEYS.PROPOSALS}:${proposal.id}`, ttl, JSON.stringify(proposal))
  } catch (error) {
    logger.error({ error, proposalId: proposal.id }, 'Failed to update proposal')
  }
}

async function deleteProposal(proposalId: string): Promise<void> {
  try {
    await redis.del(`${KEYS.PROPOSALS}:${proposalId}`)
  } catch (error) {
    logger.error({ error, proposalId }, 'Failed to delete proposal')
  }
}

// Cooldown management
function getCooldownKey(userA: string, userB: string): string {
  return userA < userB ? `${userA}|${userB}` : `${userB}|${userA}`
}

async function setCooldown(userA: string, userB: string): Promise<void> {
  try {
    const key = `${KEYS.COOLDOWNS}:${getCooldownKey(userA, userB)}`
    await redis.setex(key, Math.ceil(COOLDOWN_DURATION / 1000), '1')
  } catch (error) {
    logger.error({ error, userA, userB }, 'Failed to set cooldown')
  }
}

async function checkCooldown(userA: string, userB: string): Promise<boolean> {
  try {
    const key = `${KEYS.COOLDOWNS}:${getCooldownKey(userA, userB)}`
    const exists = await redis.exists(key)
    return exists === 1
  } catch (error) {
    logger.error({ error, userA, userB }, 'Failed to check cooldown')
    return false
  }
}

// Smart gender compatibility based on relationship type and sexual orientation
function isGenderCompatible(user1: CachedProfile, user2: CachedProfile): boolean {
  const user1Gender = (user1.gender || '').toLowerCase()
  const user2Gender = (user2.gender || '').toLowerCase()
  const user1Needs = Array.isArray(user1.needs) ? user1.needs.map(n => n.toLowerCase()) : []
  const user2Needs = Array.isArray(user2.needs) ? user2.needs.map(n => n.toLowerCase()) : []
  
  logger.debug({ 
    user1Id: user1.id,
    user2Id: user2.id,
    user1Gender,
    user2Gender,
    user1Needs,
    user2Needs
  }, '🚻 Checking gender compatibility')
  
  // Check if either user is looking for friendship - friendship is gender-neutral
  const user1WantsFriendship = user1Needs.includes('friendship')
  const user2WantsFriendship = user2Needs.includes('friendship')
  
  if (user1WantsFriendship || user2WantsFriendship) {
    logger.debug({ user1Id: user1.id, user2Id: user2.id }, '✅ Gender compatible - friendship match')
    return true // Friendship matches with any gender
  }
  
  // Relationship/dating compatibility logic
  const user1WantsRelationship = user1Needs.some(need => 
    ['boyfriend', 'girlfriend', 'dating', 'relationship', 'casual'].includes(need)
  )
  const user2WantsRelationship = user2Needs.some(need => 
    ['boyfriend', 'girlfriend', 'dating', 'relationship', 'casual'].includes(need)
  )
  
  if (!user1WantsRelationship || !user2WantsRelationship) {
    return true // If not explicitly looking for relationship, allow match
  }
  
  // Smart gender matching for relationships
  if (user1Gender === 'male' && user2Gender === 'female') {
    // Male seeking female compatibility
    const maleSeeksFemale = user1Needs.includes('girlfriend') || user1Needs.includes('dating') || user1Needs.includes('relationship') || user1Needs.includes('casual')
    const femaleSeeksMale = user2Needs.includes('boyfriend') || user2Needs.includes('dating') || user2Needs.includes('relationship') || user2Needs.includes('casual')
    return maleSeeksFemale && femaleSeeksMale
  }
  
  if (user1Gender === 'female' && user2Gender === 'male') {
    // Female seeking male compatibility
    const femaleSeeksMale = user1Needs.includes('boyfriend') || user1Needs.includes('dating') || user1Needs.includes('relationship') || user1Needs.includes('casual')
    const maleSeeksFemale = user2Needs.includes('girlfriend') || user2Needs.includes('dating') || user2Needs.includes('relationship') || user2Needs.includes('casual')
    return femaleSeeksMale && maleSeeksFemale
  }
  
  // LGBTQ+ inclusive matching
  if (user1Gender === user2Gender) {
    // Same gender - check if both are open to same-gender relationships
    const bothOpenToSameGender = (
      (user1Gender === 'male' && user1Needs.includes('boyfriend')) ||
      (user1Gender === 'female' && user1Needs.includes('girlfriend')) ||
      user1Needs.includes('dating') || user1Needs.includes('relationship') || user1Needs.includes('casual')
    ) && (
      (user2Gender === 'male' && user2Needs.includes('boyfriend')) ||
      (user2Gender === 'female' && user2Needs.includes('girlfriend')) ||
      user2Needs.includes('dating') || user2Needs.includes('relationship') || user2Needs.includes('casual')
    )
    return bothOpenToSameGender
  }
  
  // Non-binary, queer, and other gender identities - inclusive matching
  const nonBinaryGenders = ['non-binary', 'queer', 'genderfluid', 'agender', 'other']
  const user1IsNonBinary = nonBinaryGenders.includes(user1Gender)
  const user2IsNonBinary = nonBinaryGenders.includes(user2Gender)
  
  if (user1IsNonBinary || user2IsNonBinary) {
    // Non-binary users can match with anyone who is open to dating/relationships
    return user1WantsRelationship && user2WantsRelationship
  }
  
  // Default: allow match if both want relationships (inclusive approach)
  logger.debug({ user1Id: user1.id, user2Id: user2.id }, '✅ Gender compatible - default inclusive match')
  return true
}

// Advanced matching algorithm with smart gender and location scoring
function calculateCompatibilityScore(user1: CachedProfile, user2: CachedProfile, distance?: number): number {
  // Gender compatibility check (critical factor)
  if (!isGenderCompatible(user1, user2)) {
    logger.debug({ 
      user1Id: user1.id, 
      user2Id: user2.id,
      user1Gender: user1.gender,
      user2Gender: user2.gender,
      user1Needs: user1.needs,
      user2Needs: user2.needs
    }, '❌ Gender incompatible - rejecting match')
    return -1000 // Incompatible gender preferences - reject match
  }
  
  // Use enhanced compatibility service for better scoring
  const compatibility = CompatibilityService.calculateEnhancedCompatibility(
    {
      age: user1.age,
      interests: user1.interests,
      needs: user1.needs
    },
    {
      age: user2.age,
      interests: user2.interests,
      needs: user2.needs
    },
    distance
  )
  
  let score = compatibility.score
  
  // Get needs for additional checks
  const user1Needs = Array.isArray(user1.needs) ? user1.needs.map((n: string) => n.toLowerCase()) : []
  const user2Needs = Array.isArray(user2.needs) ? user2.needs.map((n: string) => n.toLowerCase()) : []
  
  // Location-based scoring with expanding circles
  if (distance !== undefined) {
    // Check if either user has international preference
    const user1HasInternationalPref = (user1 as any).location_preference === 'international'
    const user2HasInternationalPref = (user2 as any).location_preference === 'international'
    const hasInternationalPref = user1HasInternationalPref || user2HasInternationalPref
    
    // Friendship prioritizes location more than relationships (unless international)
    const prioritizeLocation = (user1Needs.includes('friendship') || user2Needs.includes('friendship')) && !hasInternationalPref
    const locationMultiplier = prioritizeLocation ? 1.5 : 1.0
    
    if (hasInternationalPref) {
      // For international preferences, distance penalties are much more lenient
      if (distance <= 100) score += 10        // Local/regional - bonus
      else if (distance <= 1000) score += 5   // National - small bonus
      else if (distance <= 5000) score += 2   // Continental - tiny bonus
      else if (distance <= 15000) score -= 5  // International - small penalty
      else score -= 10                        // Very far - moderate penalty
      
      logger.debug({ distance, scoreAdjustment: 'international_preference' }, '🌍 Applied international distance scoring')
    } else {
      // Standard distance scoring for local preferences
      if (distance <= 2) score += 20 * locationMultiplier      // Very close - huge bonus
      else if (distance <= 5) score += 15 * locationMultiplier  // Close - big bonus
      else if (distance <= 10) score += 10 * locationMultiplier // Nearby - good bonus
      else if (distance <= 25) score += 5 * locationMultiplier  // Moderate distance - small bonus
      else if (distance <= 50) score += 2 * locationMultiplier  // Far but acceptable
      else if (distance <= 100) score -= 2                      // Long distance - small penalty
      else if (distance <= 500) score -= 10                     // Very long distance - moderate penalty
      else score -= 20                                          // Extremely long distance - large penalty (capped)
      
      logger.debug({ distance, scoreAdjustment: 'local_preference' }, '📍 Applied local distance scoring')
    }
  }
  
  // Relationship type bonuses
  const relationshipTypes = ['boyfriend', 'girlfriend', 'dating', 'relationship']
  const user1WantsRelationship = user1Needs.some((need: string) => relationshipTypes.includes(need))
  const user2WantsRelationship = user2Needs.some((need: string) => relationshipTypes.includes(need))
  
  if (user1WantsRelationship && user2WantsRelationship) {
    score += 8 // Both want relationships - good compatibility
  }
  
  // Casual dating compatibility
  const user1WantsCasual = user1Needs.includes('casual')
  const user2WantsCasual = user2Needs.includes('casual')
  if (user1WantsCasual && user2WantsCasual) {
    score += 5 // Both want casual - moderate compatibility
  }
  
  logger.debug({
    enhancedScore: compatibility.score,
    finalScore: score,
    breakdown: compatibility.breakdown,
    commonInterests: compatibility.commonInterests,
    commonNeeds: compatibility.commonNeeds
  }, '🎯 Final compatibility score calculated')
  
  return score
}

// Helper function to check if user is already in an active proposal
async function isUserInActiveProposal(userId: string): Promise<boolean> {
  try {
    const proposal = await findUserProposal(userId)
    return proposal !== null && !proposal.cancelled && Date.now() <= proposal.expiresAt
  } catch (error) {
    logger.error({ error, userId }, 'Failed to check if user is in active proposal')
    return false
  }
}

// Expanding circle search with smart location prioritization
async function findBestMatch(userId: string): Promise<string | null> {
  try {
    const user = await getCachedProfile(userId)
    if (!user) {
      logger.warn({ userId }, 'User profile not found for matching')
      return null
    }
    
    // Log user profile and preferences for debugging
    logger.info({ 
      userId,
      userProfile: {
        age: user.age,
        gender: user.gender,
        interests: user.interests,
        needs: user.needs,
        location: user.latitude && user.longitude ? { lat: user.latitude, lng: user.longitude } : null,
        preferences: {
          locationPreference: user.location_preference,
          agePreference: user.age_preference,
          friendshipLocationPriority: user.friendship_location_priority,
          relationshipDistanceFlexible: user.relationship_distance_flexible
        }
      }
    }, '🔍 Starting match search for user')
    
    // Don't try to match users who are already in active proposals
    if (await isUserInActiveProposal(userId)) {
      logger.info({ userId }, 'User is already in an active proposal, skipping matching')
      return null
    }
    
    const searchingUsers = await getSearchingUsers()
    const userSearchState = searchingUsers.find(s => s.userId === userId)
    
    logger.info({ 
      userId,
      totalSearchingUsers: searchingUsers.length,
      searchingUserIds: searchingUsers.map(s => s.userId),
      userFoundInQueue: !!userSearchState
    }, '👥 Current searching users queue')
    
    // Load user's stored preferences from database
    const userPreferences = {
      locationPreference: user.location_preference || 'nearby',
      agePreference: user.age_preference || 'flexible',
      friendshipLocationPriority: user.friendship_location_priority ?? true,
      relationshipDistanceFlexible: user.relationship_distance_flexible ?? true
    }
    
    logger.info({ 
      userId,
      storedPreferences: userPreferences,
      searchStatePreferences: userSearchState?.preferences
    }, '⚙️ User preferences loaded for matching')
    
    let allCandidates: Array<{ userId: string; distance?: number }> = []
    
    // Expanding circle search algorithm
    if (userSearchState?.latitude && userSearchState?.longitude) {
      const userNeeds = Array.isArray(user.needs) ? user.needs.map(n => n.toLowerCase()) : []
      const prioritizeLocation = userNeeds.includes('friendship') && userPreferences.friendshipLocationPriority
      
      // For international preference, use much larger search radii
      const isInternationalPreference = userPreferences.locationPreference === 'international'
      
      // Define search radii based on user's location preference
      let searchRadii: number[]
      if (isInternationalPreference) {
        searchRadii = [50, 100, 500, 1000, 5000, 10000] // International: very wide search
      } else if (prioritizeLocation) {
        searchRadii = [2, 5, 10, 25, 50, 100, 200] // Friendship: prefer very close matches
      } else {
        searchRadii = [5, 15, 30, 75, 150, 300, 500] // Relationships: more flexible with distance
      }
      
      logger.info({ 
        userId, 
        locationPreference: userPreferences.locationPreference,
        prioritizeLocation,
        searchRadii 
      }, '🌍 Using search radii based on location preference')
      
      // Search in expanding circles
      for (const radius of searchRadii) {
        try {
          const nearbyUsers = await findNearbyUsers(
            userId,
            userSearchState.latitude,
            userSearchState.longitude,
            radius
          )
          
          // Add new candidates not already found in smaller circles
          const existingIds = new Set(allCandidates.map(c => c.userId))
          const newCandidates = nearbyUsers
            .filter(candidateId => !existingIds.has(candidateId))
            .map(candidateId => ({ userId: candidateId, distance: radius }))
          
          allCandidates.push(...newCandidates)
          
          // For friendship, stop early if we have good local candidates
          if (prioritizeLocation && radius <= 10 && allCandidates.length >= 5) {
            logger.info({ userId, radius, candidateCount: allCandidates.length }, 'Found enough local candidates for friendship')
            break
          }
          
          // For relationships, continue expanding but with diminishing returns
          if (!prioritizeLocation && allCandidates.length >= 20) {
            logger.info({ userId, radius, candidateCount: allCandidates.length }, 'Found sufficient candidates for relationship matching')
            break
          }
        } catch (error) {
          logger.error({ error, userId, radius }, 'Error in expanding circle search')
          continue
        }
      }
    } else {
      // Fallback to all searching users if no location
      logger.info({ userId }, '📍 No location data - searching all users')
      allCandidates = searchingUsers
        .filter(s => s.userId !== userId)
        .map(s => ({ userId: s.userId }))
    }
    
    // Additional fallback: if no location-based candidates found, search all users
    if (allCandidates.length === 0 && userSearchState?.latitude && userSearchState?.longitude) {
      logger.info({ userId }, '🌐 No location-based candidates found - falling back to all users')
      allCandidates = searchingUsers
        .filter(s => s.userId !== userId)
        .map(s => ({ userId: s.userId }))
    }
    
    // Process candidates and calculate compatibility scores
    const validCandidates: Array<{ userId: string; score: number; distance?: number }> = []
    
    logger.info({ 
      userId, 
      totalCandidates: allCandidates.length,
      candidateIds: allCandidates.slice(0, 10).map(c => c.userId) // Log first 10 candidate IDs
    }, '📋 Processing candidates for matching')
    
    for (const candidate of allCandidates.slice(0, BATCH_SIZE * 2)) { // Increased batch size for better matching
      // Check cooldown
      if (await checkCooldown(userId, candidate.userId)) {
        logger.debug({ userId, candidateId: candidate.userId }, 'Skipping candidate due to cooldown')
        continue
      }
      
      // Check if candidate is already in an active proposal
      if (await isUserInActiveProposal(candidate.userId)) {
        logger.debug({ userId, candidateId: candidate.userId }, 'Skipping candidate already in active proposal')
        continue
      }
      
      // Get candidate profile
      const candidateProfile = await getCachedProfile(candidate.userId)
      if (!candidateProfile) {
        logger.debug({ userId, candidateId: candidate.userId }, 'Skipping candidate - profile not found')
        continue
      }
      
      // Log candidate profile for debugging
      logger.debug({ 
        userId,
        candidateId: candidate.userId,
        candidateProfile: {
          age: candidateProfile.age,
          gender: candidateProfile.gender,
          interests: candidateProfile.interests,
          needs: candidateProfile.needs,
          location: candidateProfile.latitude && candidateProfile.longitude ? 
            { lat: candidateProfile.latitude, lng: candidateProfile.longitude } : null
        }
      }, '👤 Evaluating candidate')
      
      // Apply age preference filter using stored preferences
      const userAgeRange = getAgeRangeFromPreference(userPreferences.agePreference, user.age || 25)
      if (userAgeRange) {
        const [minAge, maxAge] = userAgeRange
        if (candidateProfile.age && (candidateProfile.age < minAge || candidateProfile.age > maxAge)) {
          logger.debug({ 
            userId, 
            candidateId: candidate.userId, 
            candidateAge: candidateProfile.age, 
            ageRange: [minAge, maxAge],
            agePreference: userPreferences.agePreference
          }, '❌ Candidate filtered out by age preference')
          continue
        }
      }
      
      // Calculate actual distance if both users have location
      let actualDistance = candidate.distance
      if (userSearchState?.latitude && userSearchState?.longitude && 
          candidateProfile.latitude && candidateProfile.longitude) {
        actualDistance = calculateDistance(
          userSearchState.latitude, userSearchState.longitude,
          candidateProfile.latitude, candidateProfile.longitude
        )
      }
      
      // Calculate compatibility score with actual distance
      const score = calculateCompatibilityScore(user, candidateProfile, actualDistance)
      
      // Log compatibility scoring details
      logger.debug({ 
        userId,
        candidateId: candidate.userId,
        compatibilityScore: score,
        distance: actualDistance,
        scoringDetails: {
          userAge: user.age,
          candidateAge: candidateProfile.age,
          userGender: user.gender,
          candidateGender: candidateProfile.gender,
          userInterests: user.interests,
          candidateInterests: candidateProfile.interests,
          userNeeds: user.needs,
          candidateNeeds: candidateProfile.needs
        }
      }, '🎯 Compatibility score calculated')
      
      // Only include candidates with positive compatibility scores
      if (score > 0) {
        validCandidates.push({ 
          userId: candidate.userId, 
          score, 
          distance: actualDistance 
        })
        logger.debug({ userId, candidateId: candidate.userId, score }, '✅ Candidate added to valid list')
      } else {
        logger.debug({ userId, candidateId: candidate.userId, score }, '❌ Candidate rejected due to low score')
      }
    }
    
    // Sort by compatibility score (highest first)
    if (validCandidates.length === 0) {
      logger.info({ userId, totalCandidates: allCandidates.length }, 'No compatible candidates found')
      return null
    }
    
    validCandidates.sort((a, b) => b.score - a.score)
    
    const bestMatch = validCandidates[0]
    logger.info({ 
      userId, 
      bestMatchId: bestMatch.userId, 
      score: bestMatch.score, 
      distance: bestMatch.distance,
      totalCandidates: allCandidates.length,
      validCandidates: validCandidates.length
    }, 'Found best match')
    
    return bestMatch.userId
  } catch (error) {
    logger.error({ error, userId }, 'Failed to find best match')
    return null
  }
}

// Helper function to calculate distance between two points (Haversine formula)
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371 // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

// Helper function to convert age preference to age range
function getAgeRangeFromPreference(agePreference: string, userAge: number): [number, number] | null {
  const ageRanges = {
    'close': 2,     // ±2 years
    'similar': 5,   // ±5 years
    'flexible': 10, // ±10 years
    'open': 15,     // ±15 years
    'any': null     // No age restriction
  }
  
  const range = ageRanges[agePreference as keyof typeof ageRanges]
  if (range === null) return null
  
  const minAge = Math.max(18, userAge - range) // Minimum age 18
  const maxAge = Math.min(100, userAge + range) // Maximum age 100
  
  return [minAge, maxAge]
}

// Public API functions
export async function startSearch(userId: string, preferences?: {
  latitude?: number
  longitude?: number
  maxDistance?: number
  ageRange?: [number, number]
  interests?: string[]
  needs?: string[]
}): Promise<{ searching: boolean; error?: string }> {
  try {
    // Rate limiting
    if (!(await checkRateLimit(userId))) {
      throw new Error('Rate limit exceeded')
    }
    
    // Don't allow users to start searching if they're already in an active proposal
    if (await isUserInActiveProposal(userId)) {
      logger.info({ userId }, 'User is already in an active proposal, cannot start new search')
      return { searching: false, error: 'Already in an active match proposal' }
    }
    
    // Remove user from search queue first (in case they were already searching)
    await removeFromSearchQueue(userId)
    
    const searchState: SearchState = {
      userId,
      startedAt: Date.now(),
      latitude: preferences?.latitude,
      longitude: preferences?.longitude,
      preferences: preferences || {}
    }
    
    await addToSearchQueue(searchState)
    logger.info({ userId }, 'User started searching for matches')
    
    // Attempt immediate matching
    setImmediate(() => tryPairUser(userId))
    
    // Update metrics
    await redis.incr(`${KEYS.METRICS}:searches_started`)
    
    return { searching: true }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to start search')
    throw error
  }
}

export async function cancelSearch(userId: string): Promise<void> {
  try {
    await removeFromSearchQueue(userId)
    await redis.incr(`${KEYS.METRICS}:searches_cancelled`)
    logger.info({ userId }, 'Search cancelled')
  } catch (error) {
    logger.error({ error, userId }, 'Failed to cancel search')
  }
}

// Find user's active proposal
async function findUserProposal(userId: string): Promise<Proposal | null> {
  try {
    // This is not optimal - in production, maintain a user->proposal mapping
    const proposalKeys = await redis.keys(`${KEYS.PROPOSALS}:*`)
    
    for (const key of proposalKeys) {
      const data = await redis.get(key)
      if (data) {
        const proposal = JSON.parse(data) as Proposal
        if (!proposal.cancelled && (proposal.a === userId || proposal.b === userId)) {
          // Check if expired
          if (Date.now() > proposal.expiresAt) {
            await deleteProposal(proposal.id)
            continue
          }
          return proposal
        }
      }
    }
    return null
  } catch (error) {
    logger.error({ error, userId }, 'Failed to find user proposal')
    return null
  }
}

export interface StatusResult {
  state: 'idle' | 'searching' | 'proposal' | 'matched' | 'cancelled'
  proposal?: { 
    id: string
    other: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'age' | 'gender' | 'interests' | 'needs'>
    acceptedByOther?: boolean
    message?: string 
  }
  match?: { otherName: string; chatId: string }
  message?: string
}

export async function getStatus(userId: string): Promise<StatusResult> {
  try {
    // Check for active proposal
    const proposal = await findUserProposal(userId)
    
    if (proposal) {
      const otherId = proposal.a === userId ? proposal.b : proposal.a
      const other = await getCachedProfile(otherId)
      if (!other) return { state: 'searching' }

      if (proposal.acceptedA && proposal.acceptedB) {
        // Matched!
        const otherName = `${other.first_name} ${other.last_name}`.trim()
        const chatId = `chat_${proposal.id}`
        
        // Cleanup
        await deleteProposal(proposal.id)
        await removeFromSearchQueue(proposal.a)
        await removeFromSearchQueue(proposal.b)
        
        return { 
          state: 'matched', 
          match: { otherName, chatId }, 
          message: `Hurray! You got a match with ${otherName}` 
        }
      }

      const acceptedByOther = (proposal.a === userId ? proposal.acceptedB : proposal.acceptedA)
      return {
        state: 'proposal',
        proposal: {
          id: proposal.id,
          other: {
            id: other.id,
            first_name: other.first_name,
            last_name: other.last_name,
            age: other.age,
            gender: other.gender,
            interests: other.interests,
            needs: other.needs,
          },
          acceptedByOther,
          message: acceptedByOther ? `${other.first_name} has accepted to chat. Waiting for you…` : undefined,
        },
      }
    }

    // Check if user is in search queue
    const searchingUsers = await getSearchingUsers(1000) // Check larger batch for status
    const isSearching = searchingUsers.some(s => s.userId === userId)
    
    if (isSearching) return { state: 'searching' }
    return { state: 'idle' }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to get status')
    return { state: 'idle' }
  }
}

export async function decide(userId: string, decision: 'accept' | 'pass'): Promise<StatusResult> {
  try {
    const proposal = await findUserProposal(userId)
    if (!proposal) return { state: 'idle' }

    if (decision === 'accept') {
      if (proposal.a === userId) proposal.acceptedA = true
      if (proposal.b === userId) proposal.acceptedB = true
      
      await updateProposal(proposal)
      
      // Notify the other user
      const otherId = proposal.a === userId ? proposal.b : proposal.a
      try {
        const userProfile = await getCachedProfile(userId)
        if (userProfile) {
          emitToUser(otherId, 'matchmaking:accepted_by_other', { by: userProfile.first_name })
        }
        
        // If this is a message request, emit specific events
        if (proposal.type === 'message_request') {
          emitToUser(otherId, 'message:request:accepted', {
            sender_id: proposal.a,
            receiver_id: proposal.b,
            acceptedBy: userId,
            requestId: proposal.id
          })
          emitToUser(userId, 'message:request:accepted', {
            sender_id: proposal.a,
            receiver_id: proposal.b,
            acceptedBy: userId,
            requestId: proposal.id
          })
        }
      } catch {}

      // Check if both accepted
      if (proposal.acceptedA && proposal.acceptedB) {
        const [userA, userB] = await Promise.all([
          getCachedProfile(proposal.a),
          getCachedProfile(proposal.b)
        ])
        
        const otherNameA = userB ? `${userB.first_name} ${userB.last_name}`.trim() : 'Match'
        const otherNameB = userA ? `${userA.first_name} ${userA.last_name}`.trim() : 'Match'
        
        // Create chat
        let chatId = ''
        try {
          const chat = await ensureChatForUsers(proposal.a, proposal.b)
          chatId = chat.id
        } catch {}
        
        // Automatically create friendship between matched users
        try {
          logger.info({ userA: proposal.a, userB: proposal.b }, '👥 Creating automatic friendship for matched users')
          
          // Check if friendship already exists
          const { data: existingFriendship } = await supabase
            .from('friendships')
            .select('id, status')
            .or(`and(user1_id.eq.${proposal.a},user2_id.eq.${proposal.b}),and(user1_id.eq.${proposal.b},user2_id.eq.${proposal.a})`)
            .limit(1)
            .maybeSingle()
          
          if (existingFriendship) {
            if (existingFriendship.status === 'inactive') {
              // Reactivate inactive friendship
              await supabase
                .from('friendships')
                .update({ status: 'active', updated_at: new Date().toISOString() })
                .eq('id', existingFriendship.id)
              
              logger.info({ friendshipId: existingFriendship.id }, '✅ Reactivated existing friendship for matched users')
            } else {
              logger.info({ friendshipId: existingFriendship.id }, '✅ Friendship already exists and is active')
            }
          } else {
            // Create new friendship
            const { data: newFriendship, error: friendshipError } = await supabase
              .from('friendships')
              .insert({
                user1_id: proposal.a,
                user2_id: proposal.b,
                status: 'active',
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
              })
              .select('id')
              .single()
            
            if (friendshipError) {
              logger.error({ error: friendshipError, userA: proposal.a, userB: proposal.b }, '❌ Failed to create automatic friendship')
            } else {
              logger.info({ friendshipId: newFriendship.id, userA: proposal.a, userB: proposal.b }, '✅ Created automatic friendship for matched users')
            }
          }
        } catch (error) {
          logger.error({ error, userA: proposal.a, userB: proposal.b }, '❌ Error creating automatic friendship for matched users')
        }
        
        // Cleanup
        await deleteProposal(proposal.id)
        await removeFromSearchQueue(proposal.a)
        await removeFromSearchQueue(proposal.b)
        
        // Record successful match in user_matches table for stats tracking
        try {
          // Ensure consistent ordering (smaller ID first) to avoid duplicate constraint issues
          const [user1_id, user2_id] = [proposal.a, proposal.b].sort()
          
          await supabase.from('user_matches')
            .insert({
              user1_id,
              user2_id,
              match_type: proposal.type || 'regular',
              matched_at: new Date().toISOString(),
              created_via: 'matchmaking'
            })
          
          logger.info({ user1_id, user2_id, match_type: proposal.type }, '✅ Recorded successful match in database')
        } catch (error) {
          logger.error({ error, proposal }, '❌ Failed to record match in database')
        }
        
        // Update matchmaking history
        try {
          await supabase.from('matchmaking_history')
            .update({ accepted_a: true, accepted_b: true, matched_at: new Date().toISOString() })
            .eq('proposal_id', proposal.id)
        } catch {}
        
        // Track match activity for live feed
        try {
          const userA = await findById(proposal.a)
          const userB = await findById(proposal.b)
          
          if (userA && userB) {
            await trackUserMatched(userA, userB)
            await trackChatStarted(userA, userB)
          }
        } catch (error) {
          logger.error({ error, proposal }, 'Failed to track match activity')
        }
        
        // Notify both users about match and automatic friendship
        try {
          emitToUser(proposal.a, 'matchmaking:matched', { 
            chatId, 
            otherName: otherNameA, 
            message: `Hurray! You got a match with ${otherNameA}` 
          })
          emitToUser(proposal.b, 'matchmaking:matched', { 
            chatId, 
            otherName: otherNameB, 
            message: `Hurray! You got a match with ${otherNameB}` 
          })
          
          // Notify both users about automatic friendship
          emitToUser(proposal.a, 'friend:auto_added', {
            friend_id: proposal.b,
            friend_name: otherNameA,
            message: `You're now friends with ${otherNameA}!`
          })
          emitToUser(proposal.b, 'friend:auto_added', {
            friend_id: proposal.a,
            friend_name: otherNameB,
            message: `You're now friends with ${otherNameB}!`
          })
        } catch {}
        
        // Award Circle points for successful match
        try {
          await Promise.all([
            CirclePointsService.recordActivity({
              user_id: proposal.a,
              activity_type: 'match_accepted',
              points_change: 15,
              related_user_id: proposal.b,
              metadata: { proposal_id: proposal.id, match_type: proposal.type || 'regular' }
            }),
            CirclePointsService.recordActivity({
              user_id: proposal.b,
              activity_type: 'match_accepted',
              points_change: 15,
              related_user_id: proposal.a,
              metadata: { proposal_id: proposal.id, match_type: proposal.type || 'regular' }
            })
          ])
        } catch (error) {
          logger.error({ error }, 'Failed to award Circle points for match')
        }
        
        // Update metrics
        await redis.incr(`${KEYS.METRICS}:matches_created`)
        
        return { 
          state: 'matched', 
          match: { otherName: otherNameA, chatId }, 
          message: `Hurray! You got a match with ${otherNameA}` 
        }
      }

      return getStatus(userId)
    } else {
      // Pass - enhanced logic for better user experience
      const otherId = proposal.a === userId ? proposal.b : proposal.a
      
      // Set cooldown between these specific users (1 minute)
      await setCooldown(userId, otherId)
      
      // Get user profiles for notifications
      const [userProfile, otherProfile] = await Promise.all([
        getCachedProfile(userId),
        getCachedProfile(otherId)
      ])
      
      // Cancel the current proposal
      proposal.cancelled = true
      await updateProposal(proposal)
      await deleteProposal(proposal.id)
      
      // Record Circle points for rejection
      try {
        await CirclePointsService.recordActivity({
          user_id: userId,
          activity_type: 'match_rejected',
          points_change: -2,
          related_user_id: otherId,
          metadata: { proposal_id: proposal.id, match_type: proposal.type || 'regular' }
        })
      } catch (error) {
        logger.error({ error }, 'Failed to record Circle points for rejection')
      }
      
      // Notify the other user with a positive message
      try {
        const passerName = userProfile ? userProfile.first_name : 'Someone'
        emitToUser(otherId, 'matchmaking:passed_by_other', {
          message: `${passerName} wasn't quite the right match, but don't worry! We're finding someone even better for you. 💫`,
          action: 'restart_search'
        })
        
        // If this is a message request, emit specific decline events
        if (proposal.type === 'message_request') {
          emitToUser(otherId, 'message:request:declined', {
            sender_id: proposal.a,
            receiver_id: proposal.b,
            declinedBy: userId,
            requestId: proposal.id
          })
          emitToUser(userId, 'message:request:declined', {
            sender_id: proposal.a,
            receiver_id: proposal.b,
            declinedBy: userId,
            requestId: proposal.id
          })
        }
      } catch {}
      
      // Restart matchmaking for both users immediately
      const currentTime = Date.now()
      
      // Add both users back to search queue
      if (userProfile) {
        await addToSearchQueue({
          userId,
          startedAt: currentTime,
          preferences: {}
        })
      }
      
      if (otherProfile) {
        await addToSearchQueue({
          userId: otherId,
          startedAt: currentTime,
          preferences: {}
        })
      }
      
      // Update matchmaking history
      try {
        await supabase.from('matchmaking_history')
          .update({ 
            cancelled_at: new Date().toISOString(), 
            cancel_reason: 'pass',
            cancelled_by: userId
          })
          .eq('proposal_id', proposal.id)
      } catch {}
      
      // Trigger immediate matching attempts for both users
      setImmediate(() => {
        tryPairUser(userId).catch(() => {})
        tryPairUser(otherId).catch(() => {})
      })
      
      // Update metrics
      await redis.incr(`${KEYS.METRICS}:passes_made`)
      
      return { 
        state: 'searching', 
        message: 'Looking for another match...' 
      }
    }
  } catch (error) {
    logger.error({ error, userId, decision }, 'Failed to process decision')
    return { state: 'idle' }
  }
}

// Background matching process
async function tryPairUser(userId: string): Promise<void> {
  try {
    // Double-check that user is not already in an active proposal
    if (await isUserInActiveProposal(userId)) {
      logger.info({ userId }, 'User is already in an active proposal, skipping pairing attempt')
      return
    }
    
    const bestMatchId = await findBestMatch(userId)
    if (!bestMatchId) return
    
    // Final validation before creating proposal - ensure neither user is in an active proposal
    if (await isUserInActiveProposal(userId) || await isUserInActiveProposal(bestMatchId)) {
      logger.info({ userId, bestMatchId }, 'One of the users is already in an active proposal, aborting pairing')
      return
    }
    
    // Create proposal
    const proposal = await createProposal(userId, bestMatchId)
    
    // Remove both users from search queue
    await removeFromSearchQueue(userId)
    await removeFromSearchQueue(bestMatchId)
    
    logger.info({ proposalId: proposal.id, userA: userId, userB: bestMatchId }, 'Created proposal between users')
    
    // Get user profiles for notifications
    const [userA, userB] = await Promise.all([
      getCachedProfile(proposal.a),
      getCachedProfile(proposal.b)
    ])
    
    if (userA && userB) {
      // Insert matchmaking history
      try {
        await supabase.from('matchmaking_history').insert({ 
          proposal_id: proposal.id, 
          user_a: proposal.a, 
          user_b: proposal.b 
        })
      } catch {}
      
      // Create notifications for both users about the match
      const userAName = `${userA.first_name || ''} ${userA.last_name || ''}`.trim() || 'Someone';
      const userBName = `${userB.first_name || ''} ${userB.last_name || ''}`.trim() || 'Someone';
      
      await NotificationService.notifyNewMatch(proposal.a, proposal.b, userBName);
      await NotificationService.notifyNewMatch(proposal.b, proposal.a, userAName);
      
      // Notify both users with matchmaking proposals
      emitToUser(proposal.a, 'matchmaking:proposal', {
        id: proposal.id,
        other: { 
          id: userB.id, 
          first_name: userB.first_name, 
          last_name: userB.last_name, 
          age: userB.age, 
          gender: userB.gender, 
          interests: userB.interests, 
          needs: userB.needs, 
          profile_photo_url: userB.profile_photo_url
        },
        type: 'match',
        expiresAt: proposal.expiresAt,
        data: { id: proposal.id, other: userB }
      })
      
      emitToUser(proposal.b, 'matchmaking:proposal', {
        id: proposal.id,
        other: { 
          id: userA.id, 
          first_name: userA.first_name, 
          last_name: userA.last_name, 
          age: userA.age, 
          gender: userA.gender, 
          interests: userA.interests, 
          needs: userA.needs, 
          profile_photo_url: userA.profile_photo_url
        },
        type: 'match',
        expiresAt: proposal.expiresAt,
        data: { id: proposal.id, other: userA }
      })
      // Update metrics
      await redis.incr(`${KEYS.METRICS}:proposals_created`)
    }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to pair user')
  }
}

// Background heartbeat process for cleanup and matching
export async function heartbeat(): Promise<void> {
  try {
    // Process searching users in batches
    const searchingUsers = await getSearchingUsers(BATCH_SIZE)
    
    // Filter out users who are already in active proposals to prevent race conditions
    const availableUsers = []
    for (const user of searchingUsers) {
      if (!(await isUserInActiveProposal(user.userId))) {
        availableUsers.push(user)
      }
    }
    
    // Try to pair available users (not in parallel to prevent race conditions)
    for (const user of availableUsers) {
      try {
        await tryPairUser(user.userId)
      } catch (error) {
        logger.error({ error, userId: user.userId }, 'Failed to pair user in heartbeat')
      }
    }
    
    // Update heartbeat metrics
    await redis.incr(`${KEYS.METRICS}:heartbeats`)
    
    logger.info({ 
      searchingCount: searchingUsers.length,
      availableCount: availableUsers.length,
      timestamp: Date.now() 
    }, 'Matchmaking heartbeat completed')
  } catch (error) {
    logger.error({ error }, 'Matchmaking heartbeat failed')
  }
}

// Metrics and monitoring
export async function getMetrics(): Promise<Record<string, number>> {
  try {
    const keys = [
      'searches_started',
      'searches_cancelled', 
      'proposals_created',
      'matches_created',
      'heartbeats'
    ]
    
    const values = await Promise.all(
      keys.map(key => redis.get(`${KEYS.METRICS}:${key}`))
    )
    
    const metrics: Record<string, number> = {}
    keys.forEach((key, index) => {
      metrics[key] = parseInt(values[index] || '0')
    })
    
    // Add real-time counts
    metrics.current_searching = await redis.zcard(KEYS.SEARCHING_QUEUE)
    metrics.active_proposals = (await redis.keys(`${KEYS.PROPOSALS}:*`)).length
    
    return metrics
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics')
    return {}
  }
}

// Graceful shutdown
export async function shutdown(): Promise<void> {
  try {
    await redis.quit()
    logger.info('Matchmaking service shutdown complete')
  } catch (error) {
    logger.error({ error }, 'Error during matchmaking service shutdown')
  }
}
