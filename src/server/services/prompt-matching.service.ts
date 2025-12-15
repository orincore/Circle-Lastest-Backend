import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { TogetherAIService } from './ai/together-ai.service.js'
import { MLMatchingService } from './ml-matching.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { NotificationService } from './notificationService.js'
import { PushNotificationService } from './pushNotificationService.js'

/**
 * Prompt-Based Giver/Receiver Matching Service
 * AI-Powered semantic matching between help seekers (receivers) and helpers (givers)
 * Uses Together AI for intelligent matching with ChatGPT-like understanding
 */

// Cache for embeddings to avoid redundant API calls
const embeddingCache = new Map<string, { embedding: number[], timestamp: number }>()
const EMBEDDING_CACHE_TTL = 15 * 60 * 1000 // 15 minutes - increased for better performance

export interface GiverProfile {
  id: string
  user_id: string
  is_available: boolean
  skills: string[]
  interests: string[]
  bio: string
  categories: string[]
  total_helps_given: number
  average_rating: number
  last_active_at: string
}

export interface HelpRequest {
  id: string
  receiver_user_id: string
  prompt: string
  status: 'searching' | 'matched' | 'declined_all' | 'completed' | 'cancelled' | 'expired'
  matched_giver_id?: string
  chat_room_id?: string
  attempts_count: number
  declined_giver_ids: string[]
  created_at: string
  expires_at: string
  matched_at?: string
}

export interface GiverMatch {
  giver_user_id: string
  similarity_score: number
  is_available: boolean
  total_helps_given: number
  average_rating: number
  beaconPreview?: {
    maskedName: string
    age?: number | null
    gender?: string | null
    profilePhotoUrl?: string | null
    helpTopics?: string[]
  }
}

function maskWord(word: string): string {
  const clean = (word || '').trim()
  if (!clean) return ''
  if (clean.length === 1) return '*'
  return clean[0] + '*'.repeat(clean.length - 1)
}

function maskFullName(firstName?: string | null, lastName?: string | null): string {
  const f = (firstName || '').trim()
  const l = (lastName || '').trim()

  if (f && l) return `${maskWord(f)} ${maskWord(l)}`
  if (f) return maskWord(f)
  if (l) return maskWord(l)
  return 'Beacon Helper'
}

export class PromptMatchingService {
  
  /**
   * Generate embedding for text using Together AI for enhanced semantic understanding
   * Uses caching to avoid redundant API calls
   * Falls back to deterministic embedding if Together AI is unavailable
   */
  private static async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Check cache first
      const cacheKey = text.toLowerCase().trim().substring(0, 500)
      const cached = embeddingCache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < EMBEDDING_CACHE_TTL) {
        logger.debug({ cacheHit: true }, 'Using cached embedding')
        return cached.embedding
      }

      // First try to use Together AI for better embeddings
      const embedding = await this.generateTogetherAIEmbedding(text)
      if (embedding) {
        // Cache the result
        embeddingCache.set(cacheKey, { embedding, timestamp: Date.now() })
        return embedding
      }
      
      // Fallback to deterministic embedding
      const fallbackEmbedding = this.generateDeterministicEmbedding(text)
      embeddingCache.set(cacheKey, { embedding: fallbackEmbedding, timestamp: Date.now() })
      return fallbackEmbedding
      
    } catch (error) {
      logger.error({ error, text }, 'Error generating embedding, falling back to deterministic')
      return this.generateDeterministicEmbedding(text)
    }
  }

  /**
   * Generate embedding using Together AI's embedding model
   * Uses BAAI/bge-large-en-v1.5 for high-quality semantic embeddings
   */
  private static async generateTogetherAIEmbedding(text: string): Promise<number[] | null> {
    try {
      const apiKey = process.env.TOGETHER_AI_API_KEY
      if (!apiKey) {
        logger.warn('TOGETHER_AI_API_KEY not available, using fallback embedding')
        return null
      }

      // Clean and normalize text - keep more context for better matching
      const cleanText = text.trim().substring(0, 2000)
      
      // Use Together AI's embedding endpoint with better model
      const response = await fetch('https://api.together.xyz/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'BAAI/bge-large-en-v1.5', // High-quality 1024-dim embeddings
          input: cleanText
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.warn({ status: response.status, error: errorText }, 'Together AI embedding API error, using fallback')
        return null
      }

      const data = await response.json()
      const embedding = data.data?.[0]?.embedding

      if (!embedding || !Array.isArray(embedding)) {
        logger.warn('Invalid embedding response from Together AI')
        return null
      }

      // Pad to 1536 dimensions to match our database schema
      const normalizedEmbedding = new Array(1536).fill(0)
      const copyLength = Math.min(embedding.length, 1536)
      
      for (let i = 0; i < copyLength; i++) {
        normalizedEmbedding[i] = embedding[i]
      }

      // Normalize the embedding vector
      const magnitude = Math.sqrt(normalizedEmbedding.reduce((sum, val) => sum + val * val, 0))
      if (magnitude > 0) {
        for (let i = 0; i < normalizedEmbedding.length; i++) {
          normalizedEmbedding[i] = normalizedEmbedding[i] / magnitude
        }
      }

      logger.info({ textLength: cleanText.length, embeddingDimensions: embedding.length }, 'Generated Together AI embedding')
      return normalizedEmbedding

    } catch (error) {
      logger.error({ error }, 'Error generating Together AI embedding')
      return null
    }
  }

  /**
   * Generate deterministic embedding based on text content (fallback method)
   */
  private static generateDeterministicEmbedding(text: string): number[] {
    // Clean and normalize text
    const cleanText = text.toLowerCase().trim()
    
    // Create a deterministic embedding based on text content
    const embedding = new Array(1536).fill(0)
    
    // Define keyword categories with their semantic vectors
    const keywordCategories = {
      // Programming & Development
      programming: ['coding', 'programming', 'development', 'software', 'app', 'website', 'web', 'mobile', 'frontend', 'backend', 'fullstack', 'javascript', 'python', 'react', 'node', 'database', 'api', 'debug', 'bug', 'code', 'developer', 'tech', 'technology'],
      
      // Career & Business
      career: ['career', 'job', 'work', 'business', 'professional', 'interview', 'resume', 'cv', 'promotion', 'salary', 'workplace', 'management', 'leadership', 'entrepreneur'],
      
      // Health & Fitness
      health: ['health', 'fitness', 'workout', 'exercise', 'diet', 'nutrition', 'weight', 'gym', 'running', 'yoga', 'meditation', 'mental health', 'wellness'],
      
      // Relationships & Social
      relationships: ['relationship', 'dating', 'love', 'friendship', 'family', 'social', 'communication', 'conflict', 'advice', 'support'],
      
      // Education & Learning
      education: ['education', 'learning', 'study', 'school', 'university', 'course', 'tutorial', 'teaching', 'knowledge', 'skill', 'training'],
      
      // Finance & Investment
      finance: ['finance', 'money', 'investment', 'investing', 'stocks', 'crypto', 'budget', 'savings', 'financial', 'economy', 'trading'],
      
      // Creative & Arts
      creative: ['creative', 'art', 'design', 'music', 'writing', 'photography', 'video', 'content', 'marketing', 'brand'],
      
      // Lifestyle & Personal
      lifestyle: ['lifestyle', 'personal', 'motivation', 'goals', 'habits', 'productivity', 'time management', 'organization']
    }
    
    // Calculate semantic scores for each category
    Object.entries(keywordCategories).forEach(([category, keywords], categoryIndex) => {
      let categoryScore = 0
      
      keywords.forEach(keyword => {
        if (cleanText.includes(keyword)) {
          // Boost score based on keyword importance and frequency
          const frequency = (cleanText.match(new RegExp(keyword, 'g')) || []).length
          categoryScore += frequency * (keyword.length / 10) // Longer keywords get more weight
        }
      })
      
      // Distribute category score across embedding dimensions
      const startDim = categoryIndex * 192 // 1536 / 8 categories = 192 dimensions per category
      for (let i = 0; i < 192; i++) {
        embedding[startDim + i] = categoryScore * Math.sin((i + 1) * Math.PI / 192)
      }
    })
    
    // Add text length and complexity features
    const textLength = cleanText.length
    const wordCount = cleanText.split(/\s+/).length
    const uniqueWords = new Set(cleanText.split(/\s+/)).size
    
    // Use remaining dimensions for text features
    for (let i = 1536 - 64; i < 1536; i++) {
      const featureIndex = i - (1536 - 64)
      if (featureIndex < 20) {
        embedding[i] = textLength / 1000 // Text length feature
      } else if (featureIndex < 40) {
        embedding[i] = wordCount / 100 // Word count feature
      } else {
        embedding[i] = uniqueWords / wordCount // Vocabulary diversity
      }
    }
    
    // Normalize the embedding vector
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
    if (magnitude > 0) {
      for (let i = 0; i < embedding.length; i++) {
        embedding[i] = embedding[i] / magnitude
      }
    }
    
    logger.info({ textLength, wordCount, uniqueWords, magnitude }, 'Generated deterministic embedding')
    return embedding
  }

  /**
   * Create or update giver profile with embeddings
   */
  static async createOrUpdateGiverProfile(
    userId: string,
    skills: string[] = [],
    categories: string[] = []
  ): Promise<string> {
    try {
      // Get user profile data
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('about, interests, needs')
        .eq('id', userId)
        .single()

      if (profileError) {
        throw profileError
      }

      // Combine profile data for embedding
      const profileText = [
        profile?.about || '',
        ...(profile?.interests || []),
        ...(profile?.needs || []),
        ...skills,
        ...categories
      ].filter(Boolean).join(' ')

      // Generate embedding
      const embedding = await this.generateEmbedding(profileText)

      // Call Supabase RPC to update giver profile
      const { data, error } = await supabase.rpc('update_giver_profile_embedding', {
        p_user_id: userId,
        p_embedding: JSON.stringify(embedding), // Pass as JSON string for TEXT parameter
        p_skills: skills.length > 0 ? skills : null,
        p_categories: categories.length > 0 ? categories : null
      })

      if (error) {
        throw error
      }

      logger.info({ 
        userId, 
        skillsCount: skills.length, 
        categoriesCount: categories.length,
        profileTextLength: profileText.length,
        profileText: profileText.substring(0, 100) + '...',
        embeddingMagnitude: Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0))
      }, 'Giver profile updated with embedding')
      return data

    } catch (error) {
      logger.error({ error, userId }, 'Error creating/updating giver profile')
      throw new Error('Failed to create giver profile')
    }
  }

  /**
   * Toggle giver availability
   */
  static async toggleGiverAvailability(userId: string, isAvailable: boolean): Promise<boolean> {
    try {
      const { data, error } = await supabase.rpc('toggle_giver_availability', {
        p_user_id: userId,
        p_is_available: isAvailable
      })

      if (error) {
        throw error
      }

      logger.info({ userId, isAvailable }, 'Giver availability toggled')
      return data

    } catch (error) {
      logger.error({ error, userId }, 'Error toggling giver availability')
      throw new Error('Failed to toggle availability')
    }
  }

  /**
   * Extract age and gender preferences from prompt text
   * Returns demographic filters for better matching
   */
  private static extractDemographicPreferences(prompt: string): {
    preferredGender?: 'male' | 'female' | 'other'
    preferredAgeMin?: number
    preferredAgeMax?: number
  } {
    const lowerPrompt = prompt.toLowerCase()
    const preferences: {
      preferredGender?: 'male' | 'female' | 'other'
      preferredAgeMin?: number
      preferredAgeMax?: number
    } = {}

    // Extract gender preference
    if (lowerPrompt.includes('male') && !lowerPrompt.includes('female')) {
      preferences.preferredGender = 'male'
    } else if (lowerPrompt.includes('female') && !lowerPrompt.includes('male')) {
      preferences.preferredGender = 'female'
    } else if (lowerPrompt.includes('woman') || lowerPrompt.includes('girl') || lowerPrompt.includes('lady')) {
      preferences.preferredGender = 'female'
    } else if (lowerPrompt.includes('man') || lowerPrompt.includes('guy') || lowerPrompt.includes('boy')) {
      preferences.preferredGender = 'male'
    }

    // Extract age preferences using regex patterns
    // Patterns like: "20-30", "25 to 35", "around 25", "age 30", "30 years old"
    const ageRangeMatch = lowerPrompt.match(/(\d{2})\s*[-to]+\s*(\d{2})/)
    const singleAgeMatch = lowerPrompt.match(/(?:age|around|about)\s*(\d{2})/)
    const yearsOldMatch = lowerPrompt.match(/(\d{2})\s*(?:years?\s*old|yr)/)
    
    if (ageRangeMatch) {
      // Range specified: "20-30" or "25 to 35"
      preferences.preferredAgeMin = parseInt(ageRangeMatch[1])
      preferences.preferredAgeMax = parseInt(ageRangeMatch[2])
    } else if (singleAgeMatch || yearsOldMatch) {
      // Single age mentioned: use ±5 years range
      const age = parseInt((singleAgeMatch || yearsOldMatch)![1])
      preferences.preferredAgeMin = Math.max(18, age - 5)
      preferences.preferredAgeMax = Math.min(100, age + 5)
    }

    // Age group keywords
    if (lowerPrompt.includes('teen') || lowerPrompt.includes('young')) {
      preferences.preferredAgeMin = 18
      preferences.preferredAgeMax = 25
    } else if (lowerPrompt.includes('college') || lowerPrompt.includes('university')) {
      preferences.preferredAgeMin = 18
      preferences.preferredAgeMax = 28
    } else if (lowerPrompt.includes('mid 20') || lowerPrompt.includes('mid-20')) {
      preferences.preferredAgeMin = 23
      preferences.preferredAgeMax = 28
    } else if (lowerPrompt.includes('late 20') || lowerPrompt.includes('late-20')) {
      preferences.preferredAgeMin = 27
      preferences.preferredAgeMax = 32
    } else if (lowerPrompt.includes('30s') || lowerPrompt.includes('thirties')) {
      preferences.preferredAgeMin = 30
      preferences.preferredAgeMax = 39
    } else if (lowerPrompt.includes('40s') || lowerPrompt.includes('forties')) {
      preferences.preferredAgeMin = 40
      preferences.preferredAgeMax = 49
    } else if (lowerPrompt.includes('middle age') || lowerPrompt.includes('middle-age')) {
      preferences.preferredAgeMin = 35
      preferences.preferredAgeMax = 55
    } else if (lowerPrompt.includes('senior') || lowerPrompt.includes('elderly') || lowerPrompt.includes('older')) {
      preferences.preferredAgeMin = 55
      preferences.preferredAgeMax = 100
    }

    return preferences
  }

  /**
   * Create help request and find matching giver
   * Emits real-time status updates to the receiver
   * Now considers age and gender preferences from the prompt
   */
  static async createHelpRequest(
    receiverUserId: string,
    prompt: string
  ): Promise<{ requestId: string; status: 'matched' | 'searching'; matchedGiver?: GiverMatch }> {
    try {
      // Emit searching status immediately
      emitToUser(receiverUserId, 'help_search_status', {
        status: 'analyzing',
        message: 'Analyzing your request with AI...',
        progress: 10
      })

      // Generate embedding for prompt
      const promptEmbedding = await this.generateEmbedding(prompt)

      emitToUser(receiverUserId, 'help_search_status', {
        status: 'searching',
        message: 'Searching for the perfect helper...',
        progress: 30
      })

      // Create help request
      const { data: requestId, error: requestError } = await supabase.rpc('create_help_request', {
        p_receiver_user_id: receiverUserId,
        p_prompt: prompt,
        p_prompt_embedding: JSON.stringify(promptEmbedding) // Pass as JSON string for TEXT parameter
      })

      if (requestError) {
        throw requestError
      }

      logger.info({ receiverUserId, requestId }, 'Help request created')

      emitToUser(receiverUserId, 'help_search_status', {
        status: 'matching',
        message: 'Finding the best match for you...',
        progress: 50,
        requestId
      })

      // Extract demographic preferences from prompt
      const demographics = this.extractDemographicPreferences(prompt)
      
      logger.info({ 
        receiverUserId, 
        requestId,
        demographics 
      }, 'Extracted demographic preferences from prompt')

      // Try to find matching giver with AI-powered search and demographic filters
      const matchResult = await this.findAndNotifyGiver(
        requestId, 
        receiverUserId, 
        promptEmbedding, 
        [], 
        prompt,
        demographics
      )

      // Emit final status
      if (matchResult.status === 'matched') {
        emitToUser(receiverUserId, 'help_search_status', {
          status: 'found',
          message: 'Found a perfect helper! Waiting for their response...',
          progress: 80,
          requestId,
          matchedGiver: matchResult.matchedGiver
        })
      } else {
        emitToUser(receiverUserId, 'help_search_status', {
          status: 'searching',
          message: 'Still searching for available helpers...',
          progress: 60,
          requestId
        })
      }

      return matchResult

    } catch (error) {
      logger.error({ error, receiverUserId }, 'Error creating help request')
      emitToUser(receiverUserId, 'help_search_status', {
        status: 'error',
        message: 'Failed to create help request. Please try again.',
        progress: 0
      })
      throw new Error('Failed to create help request')
    }
  }

  /**
   * Find best matching giver and send notification (AI-POWERED TARGETED MATCHING)
   * Uses Together AI for intelligent semantic matching
   * Ensures the matched giver is NOT a friend of the receiver
   * Sends real-time status updates throughout the process
   */
  static async findAndNotifyGiver(
    requestId: string,
    receiverUserId: string,
    promptEmbedding: number[],
    excludedGiverIds: string[] = [],
    originalPrompt: string = '',
    demographics?: {
      preferredGender?: 'male' | 'female' | 'other'
      preferredAgeMin?: number
      preferredAgeMax?: number
    }
  ): Promise<{ requestId: string; status: 'matched' | 'searching'; matchedGiver?: GiverMatch }> {
    try {
      // Get all friend IDs to exclude from matching
      const { data: friendships, error: friendshipError } = await supabase
        .from('friendships')
        .select('user1_id, user2_id')
        .or(`user1_id.eq.${receiverUserId},user2_id.eq.${receiverUserId}`)
        .in('status', ['active', 'accepted'])

      if (friendshipError) {
        logger.error({ error: friendshipError }, 'Error fetching friendships for exclusion')
      }

      // Extract friend user IDs
      const friendIds = friendships?.map(friendship => 
        friendship.user1_id === receiverUserId ? friendship.user2_id : friendship.user1_id
      ) || []

      // Combine excluded giver IDs with friend IDs
      const allExcludedIds = [...excludedGiverIds, ...friendIds]

      logger.info({ 
        receiverUserId, 
        friendsCount: friendIds.length, 
        totalExcluded: allExcludedIds.length 
      }, 'Excluding friends from giver matching')

      // Build query with demographic filters
      let query = supabase
        .from('giver_profiles')
        .select(`
          user_id,
          is_available,
          skills,
          categories,
          total_helps_given,
          average_rating,
          profile_embedding,
          profiles!inner(about, interests, needs, gender, age)
        `)
        .eq('is_available', true)
        .not('user_id', 'eq', receiverUserId)
        .not('user_id', 'in', `(${allExcludedIds.map(id => `"${id}"`).join(',')})`)

      // Apply gender filter if specified
      if (demographics?.preferredGender) {
        query = query.eq('profiles.gender', demographics.preferredGender)
        logger.info({ preferredGender: demographics.preferredGender }, 'Applying gender filter')
      }

      const { data: availableGivers, error: giversError } = await query
      
      if (giversError) {
        throw giversError
      }
      
      let matches: GiverMatch[] = []
      
      // Filter by age if specified
      let ageFilteredGivers = availableGivers || []
      if (demographics?.preferredAgeMin || demographics?.preferredAgeMax) {
        ageFilteredGivers = availableGivers?.filter(giver => {
          const profileData = giver.profiles as { age?: number } | null
          if (!profileData?.age) return true // Include if age unknown
          
          const userAge = profileData.age
          
          const meetsMinAge = !demographics.preferredAgeMin || userAge >= demographics.preferredAgeMin
          const meetsMaxAge = !demographics.preferredAgeMax || userAge <= demographics.preferredAgeMax
          
          return meetsMinAge && meetsMaxAge
        }) || []
        
        logger.info({ 
          totalGivers: availableGivers?.length || 0,
          ageFilteredCount: ageFilteredGivers.length,
          ageRange: `${demographics.preferredAgeMin || 'any'}-${demographics.preferredAgeMax || 'any'}`
        }, 'Applied age filter')
      }
      
      if (ageFilteredGivers && ageFilteredGivers.length > 0) {
        // Get the original prompt if not provided
        let helpPrompt = originalPrompt
        if (!helpPrompt) {
          const { data: helpRequest } = await supabase
            .from('help_requests')
            .select('prompt')
            .eq('id', requestId)
            .single()
          helpPrompt = helpRequest?.prompt || ''
        }

        // Prefer Python ML service for selecting the single best Beacon-enabled helper
        try {
          const candidateIds = ageFilteredGivers
            .map(g => g?.user_id)
            .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)

          const best = await MLMatchingService.findSingleBestMatch(receiverUserId, helpPrompt, {
            ageRange: demographics?.preferredAgeMin || demographics?.preferredAgeMax
              ? [demographics?.preferredAgeMin ?? 18, demographics?.preferredAgeMax ?? 100]
              : undefined,
            candidateIds,
            excludeUserIds: allExcludedIds,
          })

          if (best?.id) {
            const giver = ageFilteredGivers.find(g => g?.user_id === best.id)
            matches = [
              {
                giver_user_id: best.id,
                similarity_score: Math.max(0, Math.min(1, (best.match_score || 0) / 100)),
                is_available: true,
                total_helps_given: giver?.total_helps_given || 0,
                average_rating: giver?.average_rating || 0,
              }
            ]
            logger.info({
              requestId,
              receiverUserId,
              matchedGiverId: best.id,
              matchScore: best.match_score,
              candidatePoolSize: candidateIds.length,
            }, 'ML service selected best Beacon helper')
          }
        } catch (error) {
          logger.warn({ error, requestId, receiverUserId }, 'ML service selection failed, falling back to existing matching')
        }

        // Fallback to existing TogetherAI/embedding approach
        const enhancedMatches = matches.length > 0 ? [] : await this.findPerfectGiverWithAI(
          promptEmbedding,
          ageFilteredGivers,
          receiverUserId,
          helpPrompt
        )

        if (enhancedMatches.length > 0) {
          matches = enhancedMatches
          logger.info({ 
            totalAvailable: availableGivers?.length || 0,
            afterDemographicFilter: ageFilteredGivers.length,
            aiEnhancedMatches: matches.length,
            topSimilarity: matches[0]?.similarity_score || 0,
            appliedFilters: demographics
          }, 'AI-enhanced giver matching completed with demographic filters')
        } else {
          // Fallback to hybrid similarity calculation
          const scoredGivers = await Promise.all(ageFilteredGivers.map(async giver => {
            try {
              let giverEmbedding: number[]
              try {
                giverEmbedding = Array.isArray(giver.profile_embedding) 
                  ? giver.profile_embedding 
                  : JSON.parse(giver.profile_embedding)
              } catch {
                giverEmbedding = []
              }
              
              // Calculate cosine similarity
              let dotProduct = 0
              let normA = 0
              let normB = 0
              
              for (let i = 0; i < Math.min(promptEmbedding.length, giverEmbedding.length); i++) {
                dotProduct += promptEmbedding[i] * giverEmbedding[i]
                normA += promptEmbedding[i] * promptEmbedding[i]
                normB += giverEmbedding[i] * giverEmbedding[i]
              }
              
              const embeddingSimilarity = normA && normB ? dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
              
              // Calculate keyword overlap score with better weighting
              const promptWords = helpPrompt.toLowerCase().split(/\s+/).filter(w => w.length > 3)
              const profileData = giver.profiles as { about?: string; interests?: string[]; needs?: string[] } | null
              const giverAbout = (profileData?.about || '').toLowerCase()
              const giverInterests = (profileData?.interests || []).join(' ').toLowerCase()
              const giverNeeds = (profileData?.needs || []).join(' ').toLowerCase()
              const giverText = `${giverAbout} ${giverInterests} ${giverNeeds}`
              
              let keywordScore = 0
              let matchedKeywords = 0
              promptWords.forEach(word => {
                if (giverText.includes(word)) {
                  // Weight by word length and frequency
                  const wordWeight = Math.min(word.length / 10, 0.5)
                  const frequency = (giverText.match(new RegExp(word, 'g')) || []).length
                  keywordScore += wordWeight * Math.min(frequency, 3) * 0.15
                  matchedKeywords++
                }
              })
              
              // Bonus for matching multiple keywords
              const coverageBonus = promptWords.length > 0 ? (matchedKeywords / promptWords.length) * 0.2 : 0
              keywordScore = Math.min(keywordScore + coverageBonus, 0.4) // Cap at 0.4
              
              // Experience bonus (up to 0.15)
              const experienceBonus = Math.min(giver.total_helps_given * 0.015, 0.15)
              
              // Rating bonus (up to 0.1)
              const ratingBonus = (giver.average_rating || 0) * 0.02
              
              // Combined score - prioritize semantic similarity
              const finalScore = embeddingSimilarity * 0.55 + keywordScore + experienceBonus + ratingBonus
              
              return {
                giver_user_id: giver.user_id,
                similarity_score: Math.max(0, finalScore),
                is_available: giver.is_available,
                total_helps_given: giver.total_helps_given,
                average_rating: giver.average_rating || 0
              }
            } catch (error) {
              logger.error({ error, giverId: giver.user_id }, 'Error calculating similarity')
              return {
                giver_user_id: giver.user_id,
                similarity_score: 0,
                is_available: giver.is_available,
                total_helps_given: giver.total_helps_given,
                average_rating: giver.average_rating || 0
              }
            }
          }))
          
        }
      }

      if (!matches || matches.length === 0) {
        // No giver profiles available - search ALL users with AI
        logger.info({ requestId }, 'No giver profiles found, searching all users with AI')
        
        const allUserMatches = await this.searchAllUsersWithAI(
          receiverUserId,
          originalPrompt || '',
          allExcludedIds
        )
        
        if (allUserMatches.length > 0) {
          matches = allUserMatches
          logger.info({ 
            matchedUserId: matches[0]?.giver_user_id,
            similarity: matches[0]?.similarity_score
          }, 'Found match from all users search')
        }
      }

      if (!matches || matches.length === 0) {
        logger.warn({ 
          requestId, 
          receiverUserId, 
          excludedGiverIds: allExcludedIds.length,
          promptEmbeddingLength: promptEmbedding.length 
        }, 'No matching non-friend giver found')
        
        // Debug: Check if there are any available non-friend givers
        const { data: debugGivers, error: debugError } = await supabase
          .from('giver_profiles')
          .select('user_id, is_available, total_helps_given')
          .eq('is_available', true)
          .not('user_id', 'eq', receiverUserId)
          .not('user_id', 'in', `(${allExcludedIds.map(id => `"${id}"`).join(',')})`)
        
        if (debugError) {
          logger.error({ error: debugError }, 'Error checking available non-friend givers')
        } else {
          logger.info({ 
            availableNonFriendGivers: debugGivers?.length || 0,
            excludedFriendsCount: friendIds.length,
            totalExcluded: allExcludedIds.length
          }, 'Available non-friend givers debug info')
        }
        
        // Emit status update to receiver that we're still searching
        emitToUser(receiverUserId, 'help_search_status', {
          status: 'searching',
          message: 'No helpers available right now. We\'ll keep looking...',
          progress: 40,
          requestId
        })
        
        return { requestId, status: 'searching' }
      }

      // Take only the single best match for targeted approach
      const bestMatch = matches[0] as GiverMatch

      // Attach safe Beacon preview (masked) for receiver UI
      try {
        const { data: giverProfile } = await supabase
          .from('profiles')
          .select('first_name, last_name, age, gender, profile_photo_url')
          .eq('id', bestMatch.giver_user_id)
          .maybeSingle()

        const giverRow = (ageFilteredGivers || []).find((g: any) => g?.user_id === bestMatch.giver_user_id)
        const skills = Array.isArray(giverRow?.skills) ? giverRow.skills : []
        const categories = Array.isArray(giverRow?.categories) ? giverRow.categories : []
        const helpTopics = Array.from(new Set([...(skills || []), ...(categories || [])])).filter(Boolean)

        bestMatch.beaconPreview = {
          maskedName: maskFullName(giverProfile?.first_name, giverProfile?.last_name),
          age: giverProfile?.age ?? null,
          gender: giverProfile?.gender ?? null,
          profilePhotoUrl: giverProfile?.profile_photo_url ?? null,
          helpTopics: helpTopics.slice(0, 8)
        }
      } catch (_e) {
        // If preview enrichment fails, keep matching working
      }

      // Create giver request attempt record
      const { error: attemptError } = await supabase
        .from('giver_request_attempts')
        .insert({
          help_request_id: requestId,
          giver_user_id: bestMatch.giver_user_id,
          status: 'pending'
        })

      if (attemptError) {
        logger.error({ error: attemptError }, 'Error creating giver request attempt')
      }

      // Get receiver profile for notification
      const { data: receiverProfile } = await supabase
        .from('profiles')
        .select('username, first_name, profile_photo_url')
        .eq('id', receiverUserId)
        .single()

      // Get help request details
      const { data: helpRequest } = await supabase
        .from('help_requests')
        .select('prompt')
        .eq('id', requestId)
        .single()

      const promptText = helpRequest?.prompt || originalPrompt || ''
      
      // Generate AI summary for the help request
      const summary = await this.generateHelpRequestSummary(promptText)

      // Send socket event ONLY to the matched giver (targeted approach)
      emitToUser(bestMatch.giver_user_id, 'incoming_help_request', {
        requestId,
        receiverId: receiverUserId,
        receiverUsername: receiverProfile?.username || 'Someone',
        receiverFirstName: receiverProfile?.first_name || 'Someone',
        receiverPhoto: receiverProfile?.profile_photo_url,
        prompt: promptText,
        summary, // AI-generated short summary
        similarityScore: bestMatch.similarity_score,
        isTargetedMatch: true // Flag to indicate this is a targeted match
      })

      // Emit status update to receiver that a giver was found and is being notified
      emitToUser(receiverUserId, 'help_search_status', {
        status: 'found',
        message: 'Found a perfect helper! Waiting for their response...',
        progress: 80,
        requestId,
        matchedGiver: bestMatch
      })

      // Send push notification with AI-summarized content
      await PushNotificationService.sendPushNotification(
        bestMatch.giver_user_id,
        {
          title: '� Someone Needs Your Help!',
          body: summary || `Somebody needs help with something you're good at!`,
          data: {
            type: 'help_request',
            requestId,
            receiverId: receiverUserId,
            isTargetedMatch: true,
            summary
          }
        }
      )

      logger.info({ 
        requestId, 
        giverId: bestMatch.giver_user_id, 
        similarityScore: bestMatch.similarity_score,
        excludedFriendsCount: friendIds.length,
        isTargetedMatch: true
      }, 'Single perfect giver notified of targeted help request')

      return { 
        requestId, 
        status: 'matched', 
        matchedGiver: bestMatch 
      }

    } catch (error) {
      logger.error({ error, requestId }, 'Error finding and notifying giver')
      return { requestId, status: 'searching' }
    }
  }

  /**
   * Generate a short AI summary of a help request for notifications and list display
   * Uses Together AI to create a concise, actionable summary
   */
  private static async generateHelpRequestSummary(prompt: string): Promise<string> {
    try {
      const apiKey = process.env.TOGETHER_AI_API_KEY
      if (!apiKey || !prompt) {
        // Fallback: truncate and clean the prompt
        return prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt
      }

      const response = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.2-3B-Instruct-Turbo', // Fast, cheap model for summaries
          messages: [{
            role: 'system',
            content: 'You are a helpful assistant. Create a notification message in format: "Somebody needs help [doing X]" where X is what they need. Max 50 chars. Be specific. No quotes.'
          }, {
            role: 'user',
            content: prompt.substring(0, 300)
          }],
          max_tokens: 30,
          temperature: 0.3
        })
      })

      if (!response.ok) {
        logger.warn({ status: response.status }, 'AI summary generation failed')
        return prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt
      }

      const data = await response.json()
      const summary = data.choices[0]?.message?.content?.trim()

      if (!summary) {
        return prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt
      }

      // Clean up the summary
      const cleanSummary = summary
        .replace(/^["']|["']$/g, '') // Remove quotes
        .replace(/^(Summary:|Help needed:|Request:)\s*/i, '') // Remove prefixes
        .substring(0, 80) // Limit length

      logger.debug({ originalLength: prompt.length, summaryLength: cleanSummary.length }, 'Generated help request summary')
      return cleanSummary

    } catch (error) {
      logger.error({ error }, 'Error generating help request summary')
      return prompt.length > 60 ? prompt.substring(0, 57) + '...' : prompt
    }
  }

  /**
   * Use Together AI to find the perfect giver from available candidates
   * Analyzes the actual help request prompt against giver profiles
   */
  private static async findPerfectGiverWithAI(
    promptEmbedding: number[],
    availableGivers: any[],
    receiverUserId: string,
    helpPrompt: string
  ): Promise<GiverMatch[]> {
    try {
      const apiKey = process.env.TOGETHER_AI_API_KEY
      if (!apiKey || !helpPrompt) {
        logger.info('Together AI not available or no prompt for enhanced giver matching')
        return []
      }

      // Limit to top 10 candidates based on embedding similarity first
      const candidatesWithScores = availableGivers.map(giver => {
        let giverEmbedding: number[]
        try {
          giverEmbedding = Array.isArray(giver.profile_embedding) 
            ? giver.profile_embedding 
            : JSON.parse(giver.profile_embedding)
        } catch {
          giverEmbedding = []
        }
        
        let dotProduct = 0
        let normA = 0
        let normB = 0
        
        for (let i = 0; i < Math.min(promptEmbedding.length, giverEmbedding.length); i++) {
          dotProduct += promptEmbedding[i] * giverEmbedding[i]
          normA += promptEmbedding[i] * promptEmbedding[i]
          normB += giverEmbedding[i] * giverEmbedding[i]
        }
        
        const similarity = normA && normB ? dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
        
        return { giver, similarity }
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 15) // Top 15 for better AI analysis and selection

      if (candidatesWithScores.length === 0) {
        return []
      }

      // Prepare giver profiles for AI analysis
      const giverProfiles = candidatesWithScores.map(({ giver, similarity }) => ({
        id: giver.user_id,
        about: (giver.profiles?.about || '').substring(0, 200),
        interests: (giver.profiles?.interests || []).slice(0, 10),
        needs: (giver.profiles?.needs || []).slice(0, 5),
        totalHelps: giver.total_helps_given,
        rating: giver.average_rating || 0,
        embeddingScore: Math.round(similarity * 100)
      }))

      // Use Together AI to analyze and rank givers based on the actual help request
      const response = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
          messages: [{
            role: 'system',
            content: `You are an expert matching system for a help-connect app. Find the PERFECT person to help with a specific request.

Analyze the help request and available helpers. Prioritize:
1. RELEVANCE: How well their interests/expertise match the request topic (MOST IMPORTANT)
2. CAPABILITY: Whether they have knowledge/skills to actually help
3. EXPERIENCE: Their track record (total helps given)
4. QUALITY: Their rating from previous helps
5. SEMANTIC MATCH: The embeddingScore indicates AI-computed similarity

Return ONLY a JSON object with:
- "giverId": the user_id of the BEST match (choose the most relevant, not just highest score)
- "confidence": 0.0 to 1.0 (how confident you are they can ACTUALLY help)
- "reason": brief explanation (max 50 chars)

No other text, just the JSON.`
          }, {
            role: 'user',
            content: `HELP REQUEST: "${helpPrompt.substring(0, 300)}"

AVAILABLE HELPERS:
${JSON.stringify(giverProfiles, null, 2)}`
          }],
          max_tokens: 150,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.warn({ status: response.status, error: errorText }, 'Together AI giver ranking failed, using fallback')
        return []
      }

      const data = await response.json()
      const aiResponse = data.choices[0]?.message?.content

      if (!aiResponse) {
        logger.warn('Empty AI response for giver matching')
        return []
      }

      // Parse AI response
      let match: { giverId: string; confidence: number; reason?: string }
      try {
        match = JSON.parse(aiResponse)
      } catch (parseError) {
        // Try to extract JSON from response
        const jsonMatch = aiResponse.match(/\{[^}]+\}/)
        if (jsonMatch) {
          match = JSON.parse(jsonMatch[0])
        } else {
          logger.warn({ aiResponse }, 'Failed to parse AI response')
          return []
        }
      }

      const selectedCandidate = candidatesWithScores.find(c => c.giver.user_id === match.giverId)

      if (!selectedCandidate) {
        // Fallback to top embedding match
        const topCandidate = candidatesWithScores[0]
        return [{
          giver_user_id: topCandidate.giver.user_id,
          similarity_score: topCandidate.similarity,
          is_available: topCandidate.giver.is_available,
          total_helps_given: topCandidate.giver.total_helps_given,
          average_rating: topCandidate.giver.average_rating || 0
        }]
      }

      logger.info({ 
        selectedGiverId: match.giverId, 
        confidence: match.confidence,
        reason: match.reason,
        embeddingScore: selectedCandidate.similarity
      }, 'AI selected best giver')

      // Combine AI confidence with embedding similarity - prioritize AI judgment
      const finalScore = (selectedCandidate.similarity * 0.5) + (match.confidence * 0.5)

      return [{
        giver_user_id: selectedCandidate.giver.user_id,
        similarity_score: Math.max(0, finalScore),
        is_available: selectedCandidate.giver.is_available,
        total_helps_given: selectedCandidate.giver.total_helps_given,
        average_rating: selectedCandidate.giver.average_rating || 0
      }]

    } catch (error) {
      logger.error({ error }, 'Error in AI-enhanced giver matching')
      return []
    }
  }

  /**
   * Search ALL users in the database using AI to find the best match
   * This is a fallback when no giver profiles are available
   * Uses Together AI to analyze user profiles against the help request
   */
  private static async searchAllUsersWithAI(
    receiverUserId: string,
    helpPrompt: string,
    excludedUserIds: string[]
  ): Promise<GiverMatch[]> {
    try {
      if (!helpPrompt) {
        logger.info('No help prompt provided for all-users search')
        return []
      }

      // Get all users with their profiles (excluding receiver and excluded users)
      const { data: allUsers, error: usersError } = await supabase
        .from('profiles')
        .select('id, about, interests, needs, first_name, last_name')
        .not('id', 'eq', receiverUserId)
        .not('invisible_mode', 'eq', true)
        .limit(100) // Limit to prevent overwhelming the AI

      if (usersError) {
        logger.error({ error: usersError }, 'Error fetching all users')
        return []
      }

      if (!allUsers || allUsers.length === 0) {
        logger.info('No users found for matching')
        return []
      }

      // Filter out excluded users
      const eligibleUsers = allUsers.filter(user => !excludedUserIds.includes(user.id))

      if (eligibleUsers.length === 0) {
        logger.info('All users are excluded from matching')
        return []
      }

      const apiKey = process.env.TOGETHER_AI_API_KEY
      if (!apiKey) {
        logger.warn('Together AI not available for all-users search')
        return []
      }

      // Prepare user profiles for AI analysis
      const userProfiles = eligibleUsers.slice(0, 20).map(user => ({
        id: user.id,
        about: (user.about || '').substring(0, 150),
        interests: (user.interests || []).slice(0, 8),
        needs: (user.needs || []).slice(0, 5)
      }))

      // Use Together AI to find the best match from all users
      const response = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
          messages: [{
            role: 'system',
            content: `You are an expert matching system for a help-connect app. Find the PERFECT person to help with a specific request.

Analyze the help request and available users. Prioritize:
1. TOPIC RELEVANCE: How closely their interests/about match the request topic (CRITICAL)
2. EXPERTISE MATCH: Whether they have the knowledge/skills needed
3. HELPFULNESS: Likelihood they can provide valuable advice/support

Be selective - only match if confidence is HIGH (>0.6). Better to return no match than a poor match.

Return ONLY a JSON object with:
- "userId": the id of the best match (or null if no good match)
- "confidence": 0.0 to 1.0 (how confident you are this person can ACTUALLY help)
- "reason": brief explanation (max 50 chars)

If no one seems like a good match, return {"userId": null, "confidence": 0, "reason": "No suitable match"}`
          }, {
            role: 'user',
            content: `HELP REQUEST: "${helpPrompt.substring(0, 300)}"

AVAILABLE USERS:
${JSON.stringify(userProfiles, null, 2)}`
          }],
          max_tokens: 150,
          temperature: 0.1,
          response_format: { type: 'json_object' }
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        logger.warn({ status: response.status, error: errorText }, 'Together AI all-users search failed')
        return []
      }

      const data = await response.json()
      const aiResponse = data.choices[0]?.message?.content

      if (!aiResponse) {
        logger.warn('Empty AI response for all-users search')
        return []
      }

      // Parse AI response
      let match: { userId: string | null; confidence: number; reason?: string }
      try {
        match = JSON.parse(aiResponse)
      } catch (parseError) {
        const jsonMatch = aiResponse.match(/\{[^}]+\}/)
        if (jsonMatch) {
          match = JSON.parse(jsonMatch[0])
        } else {
          logger.warn({ aiResponse }, 'Failed to parse AI response for all-users search')
          return []
        }
      }

      if (!match.userId || match.confidence < 0.5) {
        logger.info({ confidence: match.confidence, reason: match.reason }, 'No suitable match found from all users (confidence threshold not met)')
        return []
      }

      const selectedUser = eligibleUsers.find(u => u.id === match.userId)
      if (!selectedUser) {
        logger.warn({ userId: match.userId }, 'AI selected user not found in eligible users')
        return []
      }

      logger.info({ 
        selectedUserId: match.userId, 
        confidence: match.confidence,
        reason: match.reason
      }, 'AI selected best user from all-users search')

      // Create a giver profile for this user on-the-fly if they don't have one
      try {
        await this.createOrUpdateGiverProfile(match.userId, [], [])
        logger.info({ userId: match.userId }, 'Created giver profile for matched user')
      } catch (profileError) {
        logger.warn({ error: profileError, userId: match.userId }, 'Failed to create giver profile, continuing anyway')
      }

      return [{
        giver_user_id: match.userId,
        similarity_score: match.confidence,
        is_available: true,
        total_helps_given: 0,
        average_rating: 0
      }]

    } catch (error) {
      logger.error({ error }, 'Error in all-users AI search')
      return []
    }
  }

  /**
   * Handle giver response (accept/decline)
   */
  static async handleGiverResponse(
    requestId: string,
    giverUserId: string,
    accepted: boolean
  ): Promise<{ success: boolean; chatId?: string; nextGiver?: boolean }> {
    try {
      // Record the response
      const { error: recordError } = await supabase.rpc('record_giver_response', {
        p_help_request_id: requestId,
        p_giver_user_id: giverUserId,
        p_accepted: accepted
      })

      if (recordError) {
        throw recordError
      }

      if (accepted) {
        // Create chat room using existing blind date logic
        const { data: helpRequest } = await supabase
          .from('help_requests')
          .select('receiver_user_id')
          .eq('id', requestId)
          .single()

        if (!helpRequest) {
          throw new Error('Help request not found')
        }

        // Create masked chat room
        const chatResult = await ensureChatForUsers(helpRequest.receiver_user_id, giverUserId)
        const chatId = typeof chatResult === 'string' ? chatResult : chatResult.id

        // Update help request with chat ID
        await supabase
          .from('help_requests')
          .update({ 
            chat_room_id: chatId,
            status: 'matched'
          })
          .eq('id', requestId)

        // Create blind date match record for message masking
        await supabase
          .from('blind_date_matches')
          .insert({
            user_a: helpRequest.receiver_user_id,
            user_b: giverUserId,
            chat_id: chatId,
            compatibility_score: 0.85, // Default score for help requests
            status: 'active',
            reveal_threshold: 30,
            message_count: 0,
            user_a_revealed: false,
            user_b_revealed: false
          })

        // Notify receiver that giver accepted
        emitToUser(helpRequest.receiver_user_id, 'help_request_accepted', {
          requestId,
          giverId: giverUserId,
          chatId,
          isBlindConnect: true
        })

        // Notify giver to navigate to chat
        emitToUser(giverUserId, 'help_request_chat_ready', {
          requestId,
          receiverId: helpRequest.receiver_user_id,
          chatId,
          isBlindConnect: true
        })

        // Send push notification to receiver in case app is closed
        await PushNotificationService.sendPushNotification(
          helpRequest.receiver_user_id,
          {
            title: '🎉 Helper Found!',
            body: 'We found someone to help you! Tap to chat anonymously.',
            data: {
              type: 'help_request_accepted',
              chatId,
              requestId,
              isBlindConnect: true,
              navigateTo: 'chat-conversation'
            }
          }
        )

        logger.info({ requestId, giverUserId, chatId }, 'Help request accepted, chat created')

        return { success: true, chatId }

      } else {
        // Giver declined - find next giver
        const { data: helpRequest } = await supabase
          .from('help_requests')
          .select('receiver_user_id, prompt, prompt_embedding, declined_giver_ids')
          .eq('id', requestId)
          .single()

        if (!helpRequest) {
          throw new Error('Help request not found')
        }

        // Notify receiver that search continues with status update
        emitToUser(helpRequest.receiver_user_id, 'help_request_declined', {
          requestId,
          searching: true
        })

        emitToUser(helpRequest.receiver_user_id, 'help_search_status', {
          status: 'searching',
          message: 'Previous helper unavailable. Finding another match...',
          progress: 50,
          requestId
        })

        // Try to find next giver
        const promptEmbedding = Array.isArray(helpRequest.prompt_embedding) 
          ? helpRequest.prompt_embedding 
          : JSON.parse(helpRequest.prompt_embedding as any)
        const nextMatch = await this.findAndNotifyGiver(
          requestId,
          helpRequest.receiver_user_id,
          promptEmbedding,
          helpRequest.declined_giver_ids || [],
          helpRequest.prompt
        )

        // Update receiver with new status
        if (nextMatch.status === 'matched') {
          emitToUser(helpRequest.receiver_user_id, 'help_search_status', {
            status: 'found',
            message: 'Found another helper! Waiting for their response...',
            progress: 80,
            requestId,
            matchedGiver: nextMatch.matchedGiver
          })
        }

        logger.info({ requestId, giverUserId, nextGiver: nextMatch.status === 'matched' }, 'Help request declined, searching for next giver')

        return { success: true, nextGiver: nextMatch.status === 'matched' }
      }

    } catch (error) {
      logger.error({ error, requestId, giverUserId }, 'Error handling giver response')
      throw new Error('Failed to handle giver response')
    }
  }

  /**
   * Cancel help request
   */
  static async cancelHelpRequest(requestId: string, userId: string): Promise<boolean> {
    try {
      const { error } = await supabase
        .from('help_requests')
        .update({ 
          status: 'cancelled',
          updated_at: new Date().toISOString()
        })
        .eq('id', requestId)
        .eq('receiver_user_id', userId)

      if (error) {
        throw error
      }

      logger.info({ requestId, userId }, 'Help request cancelled')
      return true

    } catch (error) {
      logger.error({ error, requestId, userId }, 'Error cancelling help request')
      throw new Error('Failed to cancel help request')
    }
  }

  /**
   * Get active help requests for retry logic (called by background job)
   * Now includes the original prompt for AI-powered matching
   */
  static async processActiveHelpRequests(): Promise<void> {
    try {
      // Get active requests with their prompts
      const { data: activeRequests, error } = await supabase
        .from('help_requests')
        .select('id, receiver_user_id, prompt, prompt_embedding, declined_giver_ids')
        .eq('status', 'searching')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: true })
        .limit(20)

      if (error) {
        throw error
      }

      if (!activeRequests || activeRequests.length === 0) {
        return
      }

      logger.info({ count: activeRequests.length }, 'Processing active help requests with AI')

      // Process each active request with the original prompt
      for (const request of activeRequests) {
        try {
          let promptEmbedding;
          if (Array.isArray(request.prompt_embedding)) {
            promptEmbedding = request.prompt_embedding;
          } else if (typeof request.prompt_embedding === 'string') {
            promptEmbedding = JSON.parse(request.prompt_embedding as any);
          } else {
            throw new Error('Invalid prompt embedding format');
          }
          
          // Emit status update to receiver
          emitToUser(request.receiver_user_id, 'help_search_status', {
            status: 'searching',
            message: 'Still searching for the perfect helper...',
            progress: 40,
            requestId: request.id
          })
          
          const result = await this.findAndNotifyGiver(
            request.id,
            request.receiver_user_id,
            promptEmbedding,
            request.declined_giver_ids || [],
            request.prompt // Include the original prompt for AI matching
          )

          if (result.status === 'matched') {
            emitToUser(request.receiver_user_id, 'help_search_status', {
              status: 'found',
              message: 'Found a helper! Waiting for their response...',
              progress: 80,
              requestId: request.id,
              matchedGiver: result.matchedGiver
            })
          }

          // Wait a bit between requests to avoid overwhelming the system
          await new Promise(resolve => setTimeout(resolve, 1500))
        } catch (requestError) {
          logger.error({ error: requestError, requestId: request.id }, 'Error processing individual help request')
        }
      }

    } catch (error) {
      logger.error({ error }, 'Error processing active help requests')
    }
  }

  /**
   * Expire old help requests (called by background job)
   */
  static async expireOldRequests(): Promise<number> {
    try {
      const { data: expiredCount, error } = await supabase.rpc('expire_old_help_requests')

      if (error) {
        throw error
      }

      if (expiredCount > 0) {
        logger.info({ expiredCount }, 'Expired old help requests')
      }

      return expiredCount || 0

    } catch (error) {
      logger.error({ error }, 'Error expiring old help requests')
      return 0
    }
  }

  /**
   * Get giver profile
   */
  static async getGiverProfile(userId: string): Promise<GiverProfile | null> {
    try {
      const { data, error } = await supabase
        .from('giver_profiles')
        .select('*')
        .eq('user_id', userId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          return null // No profile found
        }
        throw error
      }

      return data as GiverProfile

    } catch (error) {
      logger.error({ error, userId }, 'Error getting giver profile')
      return null
    }
  }

  /**
   * Get help request status
   */
  static async getHelpRequestStatus(requestId: string): Promise<HelpRequest | null> {
    try {
      const { data, error } = await supabase
        .from('help_requests')
        .select('*')
        .eq('id', requestId)
        .single()

      if (error) {
        if (error.code === 'PGRST116') {
          return null
        }
        throw error
      }

      return data as HelpRequest

    } catch (error) {
      logger.error({ error, requestId }, 'Error getting help request status')
      return null
    }
  }

  /**
   * Get user's active help request
   */
  static async getUserActiveRequest(userId: string): Promise<HelpRequest | null> {
    try {
      const { data, error } = await supabase
        .from('help_requests')
        .select('*')
        .eq('receiver_user_id', userId)
        .eq('status', 'searching')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) {
        throw error
      }

      return data as HelpRequest | null

    } catch (error) {
      logger.error({ error, userId }, 'Error getting user active request')
      return null
    }
  }
}
