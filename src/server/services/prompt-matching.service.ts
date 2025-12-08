import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { TogetherAIService } from './ai/together-ai.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { NotificationService } from './notificationService.js'
import { PushNotificationService } from './pushNotificationService.js'

/**
 * Prompt-Based Giver/Receiver Matching Service
 * Handles vector-based matching between help seekers (receivers) and helpers (givers)
 */

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
}

export class PromptMatchingService {
  
  /**
   * Generate embedding for text using semantic similarity
   * Creates a deterministic embedding based on text content
   */
  private static async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Clean and normalize text
      const cleanText = text.toLowerCase().trim()
      
      // Create a deterministic embedding based on text content
      // This is a simple but effective approach for matching
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
      
      logger.info({ textLength, wordCount, uniqueWords, magnitude }, 'Generated semantic embedding')
      return embedding
      
    } catch (error) {
      logger.error({ error, text }, 'Error generating embedding')
      throw new Error('Failed to generate embedding')
    }
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
        p_embedding: JSON.stringify(embedding),
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
   * Create help request and find matching giver
   */
  static async createHelpRequest(
    receiverUserId: string,
    prompt: string
  ): Promise<{ requestId: string; status: 'matched' | 'searching'; matchedGiver?: GiverMatch }> {
    try {
      // Generate embedding for prompt
      const promptEmbedding = await this.generateEmbedding(prompt)

      // Create help request
      const { data: requestId, error: requestError } = await supabase.rpc('create_help_request', {
        p_receiver_user_id: receiverUserId,
        p_prompt: prompt,
        p_prompt_embedding: JSON.stringify(promptEmbedding)
      })

      if (requestError) {
        throw requestError
      }

      logger.info({ receiverUserId, requestId }, 'Help request created')

      // Try to find matching giver
      const matchResult = await this.findAndNotifyGiver(requestId, receiverUserId, promptEmbedding)

      return matchResult

    } catch (error) {
      logger.error({ error, receiverUserId }, 'Error creating help request')
      throw new Error('Failed to create help request')
    }
  }

  /**
   * Find best matching giver and send notification
   */
  static async findAndNotifyGiver(
    requestId: string,
    receiverUserId: string,
    promptEmbedding: number[],
    excludedGiverIds: string[] = []
  ): Promise<{ requestId: string; status: 'matched' | 'searching'; matchedGiver?: GiverMatch }> {
    try {
      // Find best matching giver
      const { data: matches, error: matchError } = await supabase.rpc('find_best_giver_match', {
        p_prompt_embedding: JSON.stringify(promptEmbedding),
        p_receiver_user_id: receiverUserId,
        p_excluded_giver_ids: excludedGiverIds,
        p_limit: 1
      })

      if (matchError) {
        throw matchError
      }

      if (!matches || matches.length === 0) {
        logger.warn({ 
          requestId, 
          receiverUserId, 
          excludedGiverIds,
          promptEmbeddingLength: promptEmbedding.length 
        }, 'No matching giver found - checking available givers')
        
        // Debug: Check if there are any available givers at all
        const { data: availableGivers, error: debugError } = await supabase
          .from('giver_profiles')
          .select('user_id, is_available, total_helps_given')
          .eq('is_available', true)
        
        if (debugError) {
          logger.error({ error: debugError }, 'Error checking available givers')
        } else {
          logger.info({ 
            availableGiversCount: availableGivers?.length || 0,
            availableGivers: availableGivers?.map(g => ({ userId: g.user_id, helps: g.total_helps_given }))
          }, 'Available givers debug info')
        }
        
        return { requestId, status: 'searching' }
      }

      const bestMatch = matches[0] as GiverMatch

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

      // Send socket event to giver
      emitToUser(bestMatch.giver_user_id, 'incoming_help_request', {
        requestId,
        receiverId: receiverUserId,
        receiverUsername: receiverProfile?.username || 'Someone',
        receiverFirstName: receiverProfile?.first_name || 'Someone',
        receiverPhoto: receiverProfile?.profile_photo_url,
        prompt: helpRequest?.prompt || '',
        similarityScore: bestMatch.similarity_score
      })

      // Send push notification
      await PushNotificationService.sendPushNotification(
        bestMatch.giver_user_id,
        {
          title: 'New Help Request',
          body: `${receiverProfile?.first_name || 'Someone'} needs your help!`,
          data: {
            type: 'help_request',
            requestId,
            receiverId: receiverUserId
          }
        }
      )

      logger.info({ 
        requestId, 
        giverId: bestMatch.giver_user_id, 
        similarityScore: bestMatch.similarity_score 
      }, 'Giver notified of help request')

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
          chatId
        })

        // Notify giver to navigate to chat
        emitToUser(giverUserId, 'help_request_chat_ready', {
          requestId,
          receiverId: helpRequest.receiver_user_id,
          chatId
        })

        logger.info({ requestId, giverUserId, chatId }, 'Help request accepted, chat created')

        return { success: true, chatId }

      } else {
        // Giver declined - find next giver
        const { data: helpRequest } = await supabase
          .from('help_requests')
          .select('receiver_user_id, prompt_embedding, declined_giver_ids')
          .eq('id', requestId)
          .single()

        if (!helpRequest) {
          throw new Error('Help request not found')
        }

        // Notify receiver that search continues
        emitToUser(helpRequest.receiver_user_id, 'help_request_declined', {
          requestId,
          searching: true
        })

        // Try to find next giver
        const promptEmbedding = JSON.parse(helpRequest.prompt_embedding as any)
        const nextMatch = await this.findAndNotifyGiver(
          requestId,
          helpRequest.receiver_user_id,
          promptEmbedding,
          helpRequest.declined_giver_ids || []
        )

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
   */
  static async processActiveHelpRequests(): Promise<void> {
    try {
      const { data: activeRequests, error } = await supabase.rpc('get_active_help_requests')

      if (error) {
        throw error
      }

      if (!activeRequests || activeRequests.length === 0) {
        return
      }

      logger.info({ count: activeRequests.length }, 'Processing active help requests')

      // Process each active request
      for (const request of activeRequests) {
        const promptEmbedding = JSON.parse(request.prompt_embedding)
        
        await this.findAndNotifyGiver(
          request.request_id,
          request.receiver_user_id,
          promptEmbedding,
          request.declined_giver_ids || []
        )

        // Wait a bit between requests to avoid overwhelming the system
        await new Promise(resolve => setTimeout(resolve, 2000))
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
