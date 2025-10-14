import { logger } from '../config/logger.js'

/**
 * Enhanced Compatibility Service for Matchmaking
 * Optimized for the new categorized interests and needs system
 */

// Interest categories with weights (higher weight = more important for compatibility)
const INTEREST_CATEGORY_WEIGHTS: Record<string, number> = {
  creative: 1.2,
  tech: 1.1,
  fitness: 1.3,
  entertainment: 1.0,
  food: 1.0,
  travel: 1.4,
  learning: 1.1,
  business: 1.2,
  lifestyle: 1.0,
  social: 1.3,
  nature: 1.2,
  automotive: 0.9
}

// Map interests to their categories for smart matching
const INTEREST_TO_CATEGORY: Record<string, string> = {
  // Creative & Arts
  'Art': 'creative', 'Painting': 'creative', 'Drawing': 'creative', 'Sculpture': 'creative',
  'Photography': 'creative', 'Videography': 'creative', 'Music': 'creative', 'Singing': 'creative',
  'Playing Instruments': 'creative', 'DJing': 'creative', 'Music Production': 'creative',
  'Writing': 'creative', 'Poetry': 'creative', 'Blogging': 'creative', 'Storytelling': 'creative',
  'Design': 'creative', 'Graphic Design': 'creative', 'UI/UX Design': 'creative',
  'Fashion Design': 'creative', 'Interior Design': 'creative', 'Crafts': 'creative',
  
  // Technology
  'Coding': 'tech', 'Web Development': 'tech', 'App Development': 'tech', 'Game Development': 'tech',
  'AI & Machine Learning': 'tech', 'Data Science': 'tech', 'Blockchain': 'tech', 'Crypto': 'tech',
  'Cybersecurity': 'tech', 'Cloud Computing': 'tech', 'IoT': 'tech', 'Robotics': 'tech',
  
  // Fitness & Sports
  'Gym': 'fitness', 'Running': 'fitness', 'Yoga': 'fitness', 'Pilates': 'fitness', 'CrossFit': 'fitness',
  'Cycling': 'fitness', 'Swimming': 'fitness', 'Hiking': 'fitness', 'Rock Climbing': 'fitness',
  'Martial Arts': 'fitness', 'Boxing': 'fitness', 'Football': 'fitness', 'Basketball': 'fitness',
  
  // Travel & Adventure
  'Travel': 'travel', 'Backpacking': 'travel', 'Road Trips': 'travel', 'Solo Travel': 'travel',
  'Beach Vacations': 'travel', 'Mountain Trekking': 'travel', 'Camping': 'travel',
  'Adventure Sports': 'travel', 'Scuba Diving': 'travel', 'Skydiving': 'travel',
  
  // Add more mappings as needed...
}

// Needs compatibility matrix (how well different needs match)
const NEEDS_COMPATIBILITY_MATRIX: Record<string, Record<string, number>> = {
  'Friendship': {
    'Friendship': 10,
    'Activity Partner': 8,
    'Study Partner': 7,
    'Gym Buddy': 7,
    'Travel Buddy': 7,
    'Professional Networking': 6,
    'Dating': 3,
    'Serious Relationship': 2,
    'Boyfriend': 1,
    'Girlfriend': 1,
    'Casual': 2
  },
  'Dating': {
    'Dating': 10,
    'Casual': 8,
    'Serious Relationship': 7,
    'Boyfriend': 6,
    'Girlfriend': 6,
    'Friendship': 3,
    'Activity Partner': 4
  },
  'Serious Relationship': {
    'Serious Relationship': 10,
    'Boyfriend': 9,
    'Girlfriend': 9,
    'Dating': 7,
    'Casual': 2,
    'Friendship': 2
  },
  'Boyfriend': {
    'Girlfriend': 10,
    'Serious Relationship': 9,
    'Dating': 7,
    'Casual': 3
  },
  'Girlfriend': {
    'Boyfriend': 10,
    'Serious Relationship': 9,
    'Dating': 7,
    'Casual': 3
  },
  'Casual': {
    'Casual': 10,
    'Dating': 8,
    'Serious Relationship': 2
  },
  'Professional Networking': {
    'Professional Networking': 10,
    'Friendship': 6,
    'Creative Collaboration': 8
  },
  'Activity Partner': {
    'Activity Partner': 10,
    'Friendship': 8,
    'Gym Buddy': 7,
    'Travel Buddy': 7
  },
  'Travel Buddy': {
    'Travel Buddy': 10,
    'Activity Partner': 7,
    'Friendship': 7,
    'Adventure Sports': 8
  },
  'Study Partner': {
    'Study Partner': 10,
    'Friendship': 7,
    'Professional Networking': 6
  },
  'Gym Buddy': {
    'Gym Buddy': 10,
    'Activity Partner': 7,
    'Friendship': 7
  },
  'Creative Collaboration': {
    'Creative Collaboration': 10,
    'Professional Networking': 8,
    'Friendship': 6
  }
}

interface CompatibilityResult {
  score: number
  breakdown: {
    interests: number
    needs: number
    age: number
    location: number
    total: number
  }
  commonInterests: string[]
  commonNeeds: string[]
  categoryMatches: Record<string, number>
}

/**
 * Calculate enhanced compatibility score between two users
 */
export function calculateEnhancedCompatibility(
  user1: {
    age?: number
    interests?: string[]
    needs?: string[]
  },
  user2: {
    age?: number
    interests?: string[]
    needs?: string[]
  },
  distance?: number
): CompatibilityResult {
  let interestScore = 0
  let needsScore = 0
  let ageScore = 0
  let locationScore = 0
  
  const user1Interests = Array.isArray(user1.interests) ? user1.interests : []
  const user2Interests = Array.isArray(user2.interests) ? user2.interests : []
  const user1Needs = Array.isArray(user1.needs) ? user1.needs : []
  const user2Needs = Array.isArray(user2.needs) ? user2.needs : []
  
  // 1. Interest Compatibility (40% weight)
  const commonInterests = user1Interests.filter(i => user2Interests.includes(i))
  const categoryMatches: Record<string, number> = {}
  
  // Direct interest matches
  interestScore += commonInterests.length * 5
  
  // Category-based matching (similar interests in same category)
  const user1Categories = new Set(user1Interests.map(i => INTEREST_TO_CATEGORY[i]).filter(Boolean))
  const user2Categories = new Set(user2Interests.map(i => INTEREST_TO_CATEGORY[i]).filter(Boolean))
  
  user1Categories.forEach(cat => {
    if (user2Categories.has(cat)) {
      const weight = INTEREST_CATEGORY_WEIGHTS[cat] || 1.0
      const categoryScore = 3 * weight
      interestScore += categoryScore
      categoryMatches[cat] = categoryScore
    }
  })
  
  // Bonus for diverse shared interests (multiple categories)
  const sharedCategories = Array.from(user1Categories).filter(cat => user2Categories.has(cat))
  if (sharedCategories.length >= 3) {
    interestScore += 10 // Bonus for well-rounded compatibility
  }
  
  // 2. Needs Compatibility (35% weight)
  user1Needs.forEach(need1 => {
    user2Needs.forEach(need2 => {
      const compatibility = NEEDS_COMPATIBILITY_MATRIX[need1]?.[need2] || 0
      needsScore += compatibility
    })
  })
  
  // Normalize needs score
  if (user1Needs.length > 0 && user2Needs.length > 0) {
    needsScore = needsScore / (user1Needs.length * user2Needs.length) * 10
  }
  
  // 3. Age Compatibility (15% weight)
  if (user1.age && user2.age) {
    const ageDiff = Math.abs(user1.age - user2.age)
    if (ageDiff <= 2) ageScore = 15
    else if (ageDiff <= 5) ageScore = 12
    else if (ageDiff <= 10) ageScore = 8
    else if (ageDiff <= 15) ageScore = 4
    else ageScore = 0
  }
  
  // 4. Location Compatibility (10% weight)
  if (distance !== undefined) {
    if (distance <= 5) locationScore = 10
    else if (distance <= 10) locationScore = 8
    else if (distance <= 25) locationScore = 6
    else if (distance <= 50) locationScore = 4
    else if (distance <= 100) locationScore = 2
    else locationScore = 0
  } else {
    locationScore = 5 // Neutral score if no location data
  }
  
  // Calculate weighted total score
  const totalScore = 
    (interestScore * 0.40) +
    (needsScore * 0.35) +
    (ageScore * 0.15) +
    (locationScore * 0.10)
  
  const result: CompatibilityResult = {
    score: Math.round(totalScore * 10) / 10, // Round to 1 decimal
    breakdown: {
      interests: Math.round(interestScore * 10) / 10,
      needs: Math.round(needsScore * 10) / 10,
      age: Math.round(ageScore * 10) / 10,
      location: Math.round(locationScore * 10) / 10,
      total: Math.round(totalScore * 10) / 10
    },
    commonInterests,
    commonNeeds: user1Needs.filter(n => user2Needs.includes(n)),
    categoryMatches
  }
  
  logger.debug({
    result,
    user1InterestCount: user1Interests.length,
    user2InterestCount: user2Interests.length,
    user1NeedsCount: user1Needs.length,
    user2NeedsCount: user2Needs.length,
    distance
  }, '🎯 Enhanced compatibility calculated')
  
  return result
}

/**
 * Get compatibility percentage (0-100)
 */
export function getCompatibilityPercentage(score: number): number {
  // Map score to percentage (assuming max realistic score is around 100)
  const percentage = Math.min(Math.round((score / 100) * 100), 100)
  return Math.max(percentage, 0)
}

/**
 * Get compatibility tier
 */
export function getCompatibilityTier(score: number): {
  tier: string
  emoji: string
  description: string
} {
  const percentage = getCompatibilityPercentage(score)
  
  if (percentage >= 90) {
    return {
      tier: 'Perfect Match',
      emoji: '💯',
      description: 'Exceptional compatibility!'
    }
  } else if (percentage >= 75) {
    return {
      tier: 'Great Match',
      emoji: '🌟',
      description: 'Strong compatibility'
    }
  } else if (percentage >= 60) {
    return {
      tier: 'Good Match',
      emoji: '✨',
      description: 'Good potential'
    }
  } else if (percentage >= 40) {
    return {
      tier: 'Fair Match',
      emoji: '🤝',
      description: 'Some common ground'
    }
  } else {
    return {
      tier: 'Low Match',
      emoji: '👋',
      description: 'Different interests'
    }
  }
}

/**
 * Filter and rank potential matches by compatibility
 */
export function rankMatches<T extends { age?: number; interests?: string[]; needs?: string[] }>(
  currentUser: { age?: number; interests?: string[]; needs?: string[] },
  candidates: T[],
  distances?: Map<string, number>,
  minScore: number = 20
): Array<T & { compatibilityScore: number; compatibilityBreakdown: CompatibilityResult }> {
  const rankedMatches = candidates
    .map(candidate => {
      const candidateId = (candidate as any).id
      const distance = distances?.get(candidateId)
      const compatibility = calculateEnhancedCompatibility(currentUser, candidate, distance)
      
      return {
        ...candidate,
        compatibilityScore: compatibility.score,
        compatibilityBreakdown: compatibility
      }
    })
    .filter(match => match.compatibilityScore >= minScore)
    .sort((a, b) => b.compatibilityScore - a.compatibilityScore)
  
  logger.info({
    totalCandidates: candidates.length,
    qualifiedMatches: rankedMatches.length,
    topScore: rankedMatches[0]?.compatibilityScore,
    minScore
  }, '📊 Matches ranked by compatibility')
  
  return rankedMatches
}

export const CompatibilityService = {
  calculateEnhancedCompatibility,
  getCompatibilityPercentage,
  getCompatibilityTier,
  rankMatches
}
