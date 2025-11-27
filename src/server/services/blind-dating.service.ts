import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { CompatibilityService } from './compatibility.service.js'
import { ContentFilterService, type PersonalInfoAnalysis } from './ai/content-filter.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { NotificationService } from './notificationService.js'
import { randomUUID } from 'crypto'
import { hashPassword } from '../utils/password.js'

/**
 * Blind Dating Service
 * Handles anonymous matchmaking, identity reveal, and message filtering
 */

export interface BlindDateSettings {
  id: string
  user_id: string
  is_enabled: boolean
  daily_match_time: string
  max_active_matches: number
  preferred_reveal_threshold: number
  auto_match: boolean
  notifications_enabled: boolean
  last_match_at?: string
}

export interface BlindDateMatch {
  id: string
  user_a: string
  user_b: string
  chat_id?: string
  compatibility_score: number
  status: 'active' | 'revealed' | 'ended' | 'expired' | 'blocked'
  message_count: number
  reveal_threshold: number
  user_a_revealed: boolean
  user_b_revealed: boolean
  revealed_at?: string
  reveal_requested_by?: string
  reveal_requested_at?: string
  matched_at: string
  ended_at?: string
  ended_by?: string
  end_reason?: string
}

export interface AnonymizedProfile {
  id: string
  first_name: string
  last_name: string
  username: string
  age?: number
  gender?: string
  about?: string
  interests?: string[]
  needs?: string[]
  profile_photo_url?: string
  location_city?: string
  is_revealed: boolean
  anonymous_avatar?: string
}

export interface MessageFilterResult {
  allowed: boolean
  originalMessage: string
  filteredMessage?: string
  blockedReason?: string
  analysis?: PersonalInfoAnalysis
}

export class BlindDatingService {
  
  /**
   * Get or create blind dating settings for a user
   */
  static async getSettings(userId: string): Promise<BlindDateSettings | null> {
    try {
      const { data, error } = await supabase
        .from('blind_dating_settings')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()
      
      if (error && error.code !== 'PGRST116') {
        logger.error({ error, userId }, 'Failed to get blind dating settings')
        throw error
      }
      
      return data as BlindDateSettings | null
    } catch (error) {
      logger.error({ error, userId }, 'Error getting blind dating settings')
      return null
    }
  }

  /**
   * Update blind dating settings for a user
   */
  static async updateSettings(userId: string, settings: Partial<BlindDateSettings>): Promise<BlindDateSettings> {
    try {
      const { data, error } = await supabase
        .from('blind_dating_settings')
        .upsert({
          user_id: userId,
          ...settings,
          updated_at: new Date().toISOString()
        }, {
          onConflict: 'user_id'
        })
        .select('*')
        .single()
      
      if (error) {
        logger.error({ error, userId }, 'Failed to update blind dating settings')
        throw error
      }
      
      logger.info({ userId, isEnabled: settings.is_enabled }, 'Blind dating settings updated')
      return data as BlindDateSettings
    } catch (error) {
      logger.error({ error, userId }, 'Error updating blind dating settings')
      throw error
    }
  }

  /**
   * Enable blind dating for a user
   */
  static async enableBlindDating(userId: string): Promise<BlindDateSettings> {
    return this.updateSettings(userId, { is_enabled: true })
  }

  /**
   * Disable blind dating for a user
   */
  static async disableBlindDating(userId: string): Promise<BlindDateSettings> {
    return this.updateSettings(userId, { is_enabled: false })
  }

  /**
   * Get all active blind date matches for a user
   */
  static async getActiveMatches(userId: string): Promise<BlindDateMatch[]> {
    try {
      const { data, error } = await supabase
        .from('blind_date_matches')
        .select('*')
        .or(`user_a.eq.${userId},user_b.eq.${userId}`)
        .in('status', ['active', 'revealed'])
        .order('matched_at', { ascending: false })
      
      if (error) {
        logger.error({ error, userId }, 'Failed to get active blind date matches')
        throw error
      }
      
      return (data || []) as BlindDateMatch[]
    } catch (error) {
      logger.error({ error, userId }, 'Error getting active blind date matches')
      return []
    }
  }

  /**
   * Get blind date match by chat ID
   */
  static async getMatchByChatId(chatId: string): Promise<BlindDateMatch | null> {
    try {
      const { data, error } = await supabase
        .from('blind_date_matches')
        .select('*')
        .eq('chat_id', chatId)
        .maybeSingle()
      
      if (error && error.code !== 'PGRST116') {
        logger.error({ error, chatId }, 'Failed to get blind date match by chat ID')
        throw error
      }
      
      return data as BlindDateMatch | null
    } catch (error) {
      logger.error({ error, chatId }, 'Error getting blind date match by chat ID')
      return null
    }
  }

  /**
   * Get blind date match by ID
   */
  static async getMatchById(matchId: string): Promise<BlindDateMatch | null> {
    try {
      const { data, error } = await supabase
        .from('blind_date_matches')
        .select('*')
        .eq('id', matchId)
        .maybeSingle()
      
      if (error && error.code !== 'PGRST116') {
        logger.error({ error, matchId }, 'Failed to get blind date match')
        throw error
      }
      
      return data as BlindDateMatch | null
    } catch (error) {
      logger.error({ error, matchId }, 'Error getting blind date match')
      return null
    }
  }

  /**
   * Find and create a new blind date match for a user
   */
  static async findMatch(userId: string): Promise<BlindDateMatch | null> {
    try {
      // Check if user has blind dating enabled
      const settings = await this.getSettings(userId)
      if (!settings?.is_enabled) {
        logger.info({ userId }, 'Blind dating not enabled for user')
        return null
      }

      // Check if user has reached max active matches
      const activeMatches = await this.getActiveMatches(userId)
      if (activeMatches.length >= settings.max_active_matches) {
        logger.info({ userId, activeMatches: activeMatches.length }, 'User has reached max active blind dates')
        return null
      }

      // Get user profile for compatibility scoring
      const { data: userProfile, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()
      
      if (profileError || !userProfile) {
        logger.error({ error: profileError, userId }, 'Failed to get user profile')
        return null
      }

      // Find eligible users
      const { data: eligibleUsers, error: eligibleError } = await supabase
        .rpc('find_blind_dating_eligible_users', {
          exclude_user_id: userId,
          max_results: 50
        })
      
      if (eligibleError) {
        logger.error({ error: eligibleError, userId }, 'Failed to find eligible users')
        
        // Fallback query if RPC fails
        const { data: fallbackUsers, error: fallbackError } = await supabase
          .from('profiles')
          .select('id, age, gender, interests, needs, location_city, location_country')
          .neq('id', userId)
          .is('deleted_at', null)
          .or('is_suspended.is.null,is_suspended.eq.false')
          .or('invisible_mode.is.null,invisible_mode.eq.false')
          .limit(50)
        
        if (fallbackError) {
          logger.error({ error: fallbackError, userId }, 'Fallback query also failed')
          return null
        }
        
        // Filter by blind dating settings
        const { data: enabledUsers } = await supabase
          .from('blind_dating_settings')
          .select('user_id')
          .eq('is_enabled', true)
          .in('user_id', (fallbackUsers || []).map(u => u.id))
        
        const enabledUserIds = new Set((enabledUsers || []).map(u => u.user_id))
        const filteredUsers = (fallbackUsers || [])
          .filter(u => enabledUserIds.has(u.id))
          .map(u => ({ user_id: u.id, compatibility_data: u }))
        
        if (filteredUsers.length === 0) {
          logger.info({ userId }, 'No eligible users found for blind dating')
          return null
        }
        
        return this.createMatchFromCandidates(userId, userProfile, filteredUsers, settings)
      }

      if (!eligibleUsers || eligibleUsers.length === 0) {
        logger.info({ userId }, 'No eligible users found for blind dating')
        return null
      }

      return this.createMatchFromCandidates(userId, userProfile, eligibleUsers, settings)
    } catch (error) {
      logger.error({ error, userId }, 'Error finding blind date match')
      return null
    }
  }

  /**
   * Create a match from candidate users
   */
  private static async createMatchFromCandidates(
    userId: string,
    userProfile: any,
    candidates: Array<{ user_id: string; compatibility_data: any }>,
    settings: BlindDateSettings
  ): Promise<BlindDateMatch | null> {
    try {
      // Score and rank candidates
      const scoredCandidates = candidates.map(candidate => {
        const data = typeof candidate.compatibility_data === 'string'
          ? JSON.parse(candidate.compatibility_data)
          : candidate.compatibility_data
        
        const compatibility = CompatibilityService.calculateEnhancedCompatibility(
          {
            age: userProfile.age,
            interests: userProfile.interests,
            needs: userProfile.needs
          },
          {
            age: data.age,
            interests: data.interests,
            needs: data.needs
          }
        )
        
        return {
          userId: candidate.user_id,
          score: compatibility.score,
          compatibility
        }
      })

      // Sort by score (highest first)
      scoredCandidates.sort((a, b) => b.score - a.score)

      // Get the best match
      const bestMatch = scoredCandidates[0]
      if (!bestMatch || bestMatch.score < 10) { // Minimum compatibility threshold
        logger.info({ userId, bestScore: bestMatch?.score }, 'No sufficiently compatible users found')
        return null
      }

      // Create the blind date match
      const [userA, userB] = [userId, bestMatch.userId].sort() // Ensure consistent ordering
      
      // Create chat first
      const chat = await ensureChatForUsers(userId, bestMatch.userId)

      const { data: match, error: matchError } = await supabase
        .from('blind_date_matches')
        .insert({
          user_a: userA,
          user_b: userB,
          chat_id: chat.id,
          compatibility_score: bestMatch.score,
          status: 'active',
          message_count: 0,
          reveal_threshold: settings.preferred_reveal_threshold,
          user_a_revealed: false,
          user_b_revealed: false,
          matched_at: new Date().toISOString()
        })
        .select('*')
        .single()
      
      if (matchError) {
        logger.error({ error: matchError, userId, matchUserId: bestMatch.userId }, 'Failed to create blind date match')
        throw matchError
      }

      // Update last match time for both users
      await Promise.all([
        supabase
          .from('blind_dating_settings')
          .update({ last_match_at: new Date().toISOString() })
          .eq('user_id', userId),
        supabase
          .from('blind_dating_settings')
          .update({ last_match_at: new Date().toISOString() })
          .eq('user_id', bestMatch.userId)
      ])

      logger.info({ 
        matchId: match.id, 
        userId, 
        matchUserId: bestMatch.userId, 
        score: bestMatch.score 
      }, 'Blind date match created')

      // Notify both users
      const matchData = match as BlindDateMatch
      await this.notifyMatchCreated(userId, bestMatch.userId, matchData)

      return matchData
    } catch (error) {
      logger.error({ error, userId }, 'Error creating match from candidates')
      return null
    }
  }

  /**
   * Notify users about a new blind date match
   */
  private static async notifyMatchCreated(userId: string, otherUserId: string, match: BlindDateMatch): Promise<void> {
    try {
      // Get anonymized profiles
      const userProfile = await this.getAnonymizedProfile(otherUserId, false)
      const otherProfile = await this.getAnonymizedProfile(userId, false)

      // Emit socket events
      emitToUser(userId, 'blind_date:new_match', {
        matchId: match.id,
        chatId: match.chat_id,
        otherUser: userProfile,
        compatibilityScore: match.compatibility_score,
        revealThreshold: match.reveal_threshold
      })

      emitToUser(otherUserId, 'blind_date:new_match', {
        matchId: match.id,
        chatId: match.chat_id,
        otherUser: otherProfile,
        compatibilityScore: match.compatibility_score,
        revealThreshold: match.reveal_threshold
      })

      // Create in-app notifications
      await NotificationService.createNotification({
        recipient_id: userId,
        type: 'blind_date_match',
        title: '🎭 New Blind Date!',
        message: 'You have a new anonymous match! Start chatting to discover who they are.',
        data: { matchId: match.id, chatId: match.chat_id }
      })

      await NotificationService.createNotification({
        recipient_id: otherUserId,
        type: 'blind_date_match',
        title: '🎭 New Blind Date!',
        message: 'You have a new anonymous match! Start chatting to discover who they are.',
        data: { matchId: match.id, chatId: match.chat_id }
      })
    } catch (error) {
      logger.error({ error, userId, otherUserId }, 'Failed to notify users about blind date match')
    }
  }

  /**
   * Check if a chat is a blind date chat
   */
  static async isBlindDateChat(chatId: string): Promise<boolean> {
    try {
      const { data: match, error } = await supabase
        .from('blind_date_matches')
        .select('id, status')
        .eq('chat_id', chatId)
        .in('status', ['active', 'revealed'])
        .maybeSingle()
      
      if (error && error.code !== 'PGRST116') {
        logger.error({ error, chatId }, 'Error checking if chat is blind date')
        return false
      }
      
      return !!match
    } catch (error) {
      logger.error({ error, chatId }, 'Error checking blind date chat')
      return false
    }
  }

  /**
   * Get anonymized profile for blind dating
   */
  static async getAnonymizedProfile(userId: string, isRevealed: boolean): Promise<AnonymizedProfile | null> {
    try {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, username, age, gender, about, interests, needs, profile_photo_url, location_city')
        .eq('id', userId)
        .single()
      
      if (error || !profile) {
        logger.error({ error, userId }, 'Failed to get profile for anonymization')
        return null
      }

      if (isRevealed) {
        return {
          id: profile.id,
          first_name: profile.first_name,
          last_name: profile.last_name,
          username: profile.username,
          age: profile.age,
          gender: profile.gender,
          about: profile.about,
          interests: profile.interests,
          needs: profile.needs,
          profile_photo_url: profile.profile_photo_url,
          location_city: profile.location_city,
          is_revealed: true,
          anonymous_avatar: undefined
        }
      }

      // Anonymize the profile - Format: "A***** S*******"
      const anonymizeName = (name: string | null | undefined): string => {
        if (!name || name.length === 0) return '***'
        if (name.length === 1) return name + '****'
        // First letter + stars for rest
        return name.charAt(0) + '*'.repeat(Math.max(name.length - 1, 4))
      }

      const anonymizedFirstName = anonymizeName(profile.first_name)
      const anonymizedLastName = anonymizeName(profile.last_name)

      // Generate a consistent anonymous avatar using user ID
      const anonymousAvatar = `https://api.dicebear.com/7.x/shapes/svg?seed=${userId}&backgroundColor=b6e3f4,c0aede,d1d4f9`

      return {
        id: profile.id,
        first_name: anonymizedFirstName,
        last_name: anonymizedLastName,
        username: '***hidden***',
        age: profile.age,
        gender: profile.gender,
        about: undefined, // Hidden in anonymous mode
        interests: profile.interests,
        needs: profile.needs, // This contains the preference (girlfriend, boyfriend, etc.)
        profile_photo_url: profile.profile_photo_url, // Show blurry photo
        location_city: profile.location_city,
        anonymous_avatar: anonymousAvatar,
        is_revealed: false
      }
    } catch (error) {
      logger.error({ error, userId }, 'Error getting anonymized profile')
      return null
    }
  }

  /**
   * Check if reveal is available for a match
   * Uses dynamic threshold: base threshold, then check every 5 messages
   */
  static isRevealAvailable(match: BlindDateMatch): boolean {
    if (match.status !== 'active') {
      return false
    }

    const messageCount = match.message_count
    const threshold = match.reveal_threshold

    // Not reached initial threshold yet
    if (messageCount < threshold) {
      return false
    }

    // At or past threshold - check if we're at a checkpoint
    // Checkpoints: threshold, threshold+5, threshold+10, etc.
    const messagesSinceThreshold = messageCount - threshold
    const checkInterval = 5
    
    // Allow reveal at threshold itself
    if (messagesSinceThreshold === 0) {
      return true
    }
    
    // After threshold, only at 5-message intervals
    return messagesSinceThreshold % checkInterval === 0
  }

  /**
   * Get next reveal checkpoint
   */
  static getNextRevealCheckpoint(match: BlindDateMatch): number {
    const messageCount = match.message_count
    const threshold = match.reveal_threshold

    if (messageCount < threshold) {
      return threshold
    }

    const messagesSinceThreshold = messageCount - threshold
    const checkInterval = 5
    const nextCheckpointOffset = (Math.floor(messagesSinceThreshold / checkInterval) + 1) * checkInterval
    
    return threshold + nextCheckpointOffset
  }

  /**
   * Get messages until next reveal opportunity
   */
  static getMessagesUntilReveal(match: BlindDateMatch): number {
    const nextCheckpoint = this.getNextRevealCheckpoint(match)
    return Math.max(0, nextCheckpoint - match.message_count)
  }

  /**
   * Request identity reveal
   */
  static async requestReveal(matchId: string, requestingUserId: string): Promise<{ success: boolean; bothRevealed: boolean; message: string }> {
    try {
      const match = await this.getMatchById(matchId)
      if (!match) {
        return { success: false, bothRevealed: false, message: 'Match not found' }
      }

      if (match.status !== 'active') {
        return { success: false, bothRevealed: false, message: 'Match is not active' }
      }

      if (!this.isRevealAvailable(match)) {
        return { 
          success: false, 
          bothRevealed: false, 
          message: `Need ${match.reveal_threshold - match.message_count} more messages before revealing` 
        }
      }

      // Determine which user is requesting
      const isUserA = match.user_a === requestingUserId
      const isUserB = match.user_b === requestingUserId
      
      if (!isUserA && !isUserB) {
        return { success: false, bothRevealed: false, message: 'You are not part of this match' }
      }

      // Update reveal status
      const updateData: any = {
        updated_at: new Date().toISOString()
      }

      if (isUserA) {
        updateData.user_a_revealed = true
      } else {
        updateData.user_b_revealed = true
      }

      // Check if this is the first reveal request
      if (!match.reveal_requested_by) {
        updateData.reveal_requested_by = requestingUserId
        updateData.reveal_requested_at = new Date().toISOString()
      }

      // Check if both will be revealed after this update
      const bothRevealed = (isUserA && match.user_b_revealed) || (isUserB && match.user_a_revealed)
      
      if (bothRevealed) {
        updateData.status = 'revealed'
        updateData.revealed_at = new Date().toISOString()
      }

      const { error } = await supabase
        .from('blind_date_matches')
        .update(updateData)
        .eq('id', matchId)

      if (error) {
        logger.error({ error, matchId, requestingUserId }, 'Failed to update reveal status')
        throw error
      }

      // Notify the other user
      const otherUserId = isUserA ? match.user_b : match.user_a
      
      if (bothRevealed) {
        // Both revealed - send full profiles
        const [profile1, profile2] = await Promise.all([
          this.getAnonymizedProfile(match.user_a, true),
          this.getAnonymizedProfile(match.user_b, true)
        ])

        emitToUser(match.user_a, 'blind_date:revealed', {
          matchId,
          chatId: match.chat_id,
          otherUser: profile2,
          message: 'Identity revealed! You can now see each other\'s full profile.'
        })

        emitToUser(match.user_b, 'blind_date:revealed', {
          matchId,
          chatId: match.chat_id,
          otherUser: profile1,
          message: 'Identity revealed! You can now see each other\'s full profile.'
        })

        // Create automatic friendship
        await this.createFriendshipForRevealedMatch(match.user_a, match.user_b)
      } else {
        // Notify other user about reveal request
        emitToUser(otherUserId, 'blind_date:reveal_requested', {
          matchId,
          chatId: match.chat_id,
          message: 'Your match wants to reveal their identity! Tap to reveal yours too.'
        })
      }

      logger.info({ matchId, requestingUserId, bothRevealed }, 'Reveal requested')

      return { 
        success: true, 
        bothRevealed, 
        message: bothRevealed 
          ? 'Both identities revealed!' 
          : 'Waiting for the other person to reveal their identity'
      }
    } catch (error) {
      logger.error({ error, matchId, requestingUserId }, 'Error requesting reveal')
      return { success: false, bothRevealed: false, message: 'Failed to request reveal' }
    }
  }

  /**
   * Create friendship when both users reveal
   */
  private static async createFriendshipForRevealedMatch(userA: string, userB: string): Promise<void> {
    try {
      // Check if friendship already exists
      const { data: existing } = await supabase
        .from('friendships')
        .select('id')
        .or(`and(user1_id.eq.${userA},user2_id.eq.${userB}),and(user1_id.eq.${userB},user2_id.eq.${userA})`)
        .maybeSingle()

      if (!existing) {
        await supabase
          .from('friendships')
          .insert({
            user1_id: userA < userB ? userA : userB,
            user2_id: userA < userB ? userB : userA,
            status: 'active',
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        
        logger.info({ userA, userB }, 'Created friendship for revealed blind date match')
      }
    } catch (error) {
      logger.error({ error, userA, userB }, 'Failed to create friendship for revealed match')
    }
  }

  /**
   * Filter a message for personal information in blind date chat
   */
  static async filterMessage(
    message: string,
    matchId: string,
    senderId: string
  ): Promise<MessageFilterResult> {
    try {
      const match = await this.getMatchById(matchId)
      if (!match) {
        return { allowed: false, originalMessage: message, blockedReason: 'Match not found' }
      }

      // If identities are revealed, allow all messages
      if (match.status === 'revealed') {
        return { allowed: true, originalMessage: message }
      }

      // Quick check for obvious personal info
      if (!ContentFilterService.quickCheck(message)) {
        return { allowed: true, originalMessage: message }
      }

      // Full AI analysis
      const analysis = await ContentFilterService.analyzeMessage(message, {
        messageCount: match.message_count
      })

      if (!analysis.containsPersonalInfo) {
        return { allowed: true, originalMessage: message, analysis }
      }

      // Message contains personal info - block it
      const blockedReason = `Personal information detected: ${analysis.detectedTypes.join(', ')}`
      
      // Store blocked message
      await supabase
        .from('blind_date_blocked_messages')
        .insert({
          blind_date_id: matchId,
          sender_id: senderId,
          original_message: message,
          filtered_message: ContentFilterService.sanitizeMessage(message, analysis),
          blocked_reason: blockedReason,
          detection_confidence: analysis.confidence,
          ai_analysis: analysis as any,
          was_released: false
        })

      logger.info({ 
        matchId, 
        senderId, 
        detectedTypes: analysis.detectedTypes 
      }, 'Message blocked for personal info in blind date')

      return {
        allowed: false,
        originalMessage: message,
        filteredMessage: ContentFilterService.sanitizeMessage(message, analysis),
        blockedReason,
        analysis
      }
    } catch (error) {
      logger.error({ error, matchId, senderId }, 'Error filtering message')
      // In case of error, allow the message but log it
      return { allowed: true, originalMessage: message }
    }
  }

  /**
   * End a blind date match
   */
  static async endMatch(matchId: string, userId: string, reason?: string): Promise<boolean> {
    try {
      const match = await this.getMatchById(matchId)
      if (!match) {
        return false
      }

      if (match.user_a !== userId && match.user_b !== userId) {
        return false
      }

      const { error } = await supabase
        .from('blind_date_matches')
        .update({
          status: 'ended',
          ended_at: new Date().toISOString(),
          ended_by: userId,
          end_reason: reason || 'user_ended',
          updated_at: new Date().toISOString()
        })
        .eq('id', matchId)

      if (error) {
        logger.error({ error, matchId, userId }, 'Failed to end blind date match')
        return false
      }

      // Notify the other user
      const otherUserId = match.user_a === userId ? match.user_b : match.user_a
      emitToUser(otherUserId, 'blind_date:ended', {
        matchId,
        chatId: match.chat_id,
        message: 'The blind date has ended.'
      })

      logger.info({ matchId, userId, reason }, 'Blind date match ended')
      return true
    } catch (error) {
      logger.error({ error, matchId, userId }, 'Error ending blind date match')
      return false
    }
  }

  /**
   * Get match status for a chat
   */
  static async getChatBlindDateStatus(chatId: string, userId: string): Promise<{
    isBlindDate: boolean
    match?: BlindDateMatch
    otherUserProfile?: AnonymizedProfile
    canReveal: boolean
    messagesUntilReveal: number
  } | null> {
    try {
      const match = await this.getMatchByChatId(chatId)
      
      if (!match) {
        return { isBlindDate: false, canReveal: false, messagesUntilReveal: 0 }
      }

      const isUserA = match.user_a === userId
      const otherUserId = isUserA ? match.user_b : match.user_a
      const isRevealed = match.status === 'revealed' || 
                        (isUserA ? match.user_b_revealed : match.user_a_revealed)

      const otherUserProfile = await this.getAnonymizedProfile(otherUserId, isRevealed)
      const canReveal = this.isRevealAvailable(match)
      const messagesUntilReveal = this.getMessagesUntilReveal(match)

      return {
        isBlindDate: true,
        match,
        otherUserProfile: otherUserProfile || undefined,
        canReveal,
        messagesUntilReveal
      }
    } catch (error) {
      logger.error({ error, chatId, userId }, 'Error getting chat blind date status')
      return null
    }
  }

  /**
   * Process daily matches for all enabled users
   * This should be called by a scheduled job (cron)
   */
  static async processDailyMatches(): Promise<{ processed: number; matched: number; errors: number }> {
    const stats = { processed: 0, matched: 0, errors: 0 }
    
    try {
      const today = new Date().toISOString().split('T')[0]
      
      // Get all users with blind dating enabled who haven't been processed today
      const { data: enabledUsers, error } = await supabase
        .from('blind_dating_settings')
        .select('user_id')
        .eq('is_enabled', true)
        .eq('auto_match', true)
        .not('user_id', 'in', `(
          SELECT user_id FROM blind_date_daily_queue 
          WHERE scheduled_date = '${today}' AND status = 'matched'
        )`)
      
      if (error) {
        logger.error({ error }, 'Failed to get enabled users for daily matching')
        return stats
      }

      logger.info({ userCount: enabledUsers?.length || 0 }, 'Processing daily blind date matches')

      for (const user of (enabledUsers || [])) {
        stats.processed++
        
        try {
          // Create queue entry
          await supabase
            .from('blind_date_daily_queue')
            .upsert({
              user_id: user.user_id,
              scheduled_date: today,
              status: 'pending'
            }, {
              onConflict: 'user_id,scheduled_date'
            })

          // Try to find a match
          const match = await this.findMatch(user.user_id)
          
          if (match) {
            stats.matched++
            
            // Update queue entry
            await supabase
              .from('blind_date_daily_queue')
              .update({
                status: 'matched',
                matched_user_id: match.user_a === user.user_id ? match.user_b : match.user_a,
                match_id: match.id,
                processed_at: new Date().toISOString()
              })
              .eq('user_id', user.user_id)
              .eq('scheduled_date', today)
          } else {
            // No match found
            await supabase
              .from('blind_date_daily_queue')
              .update({
                status: 'no_match',
                processed_at: new Date().toISOString()
              })
              .eq('user_id', user.user_id)
              .eq('scheduled_date', today)
          }
        } catch (error) {
          stats.errors++
          logger.error({ error, userId: user.user_id }, 'Error processing daily match for user')
          
          await supabase
            .from('blind_date_daily_queue')
            .update({
              status: 'error',
              error_message: error instanceof Error ? error.message : 'Unknown error',
              processed_at: new Date().toISOString()
            })
            .eq('user_id', user.user_id)
            .eq('scheduled_date', today)
        }
      }

      logger.info(stats, 'Daily blind date matching completed')
      return stats
    } catch (error) {
      logger.error({ error }, 'Error in daily match processing')
      return stats
    }
  }

  // ============================================================
  // TEST MODE METHODS
  // ============================================================

  /**
   * Create a test match with an AI bot for testing purposes
   */
  static async createTestMatch(userId: string): Promise<{ match: BlindDateMatch; botUserId: string } | null> {
    try {
      // Check if test bot user exists, create if not
      const testBotId = await this.ensureTestBotUser()
      if (!testBotId) {
        logger.error({ userId }, 'Failed to create/get test bot user')
        return null
      }

      // Ensure consistent ordering
      const [userA, userB] = [userId, testBotId].sort()

      // Check if match already exists
      const { data: existingMatch, error: checkError } = await supabase
        .from('blind_date_matches')
        .select('*')
        .eq('user_a', userA)
        .eq('user_b', userB)
        .in('status', ['active', 'revealed'])
        .maybeSingle()

      if (checkError && checkError.code !== 'PGRST116') {
        logger.error({ error: checkError, userId }, 'Error checking for existing test match')
      }

      if (existingMatch) {
        logger.info({ matchId: existingMatch.id, userId, botId: testBotId }, 'Test match already exists')
        return {
          match: existingMatch as BlindDateMatch,
          botUserId: testBotId
        }
      }

      // Get user settings
      const settings = await this.getSettings(userId)
      const revealThreshold = settings?.preferred_reveal_threshold || 30

      // Create chat between user and bot
      let chat
      try {
        chat = await ensureChatForUsers(userId, testBotId)
      } catch (error) {
        logger.error({ error, userId, testBotId }, 'Failed to create/ensure chat')
        throw error
      }

      // Create the blind date match
      const { data: match, error: matchError } = await supabase
        .from('blind_date_matches')
        .insert({
          user_a: userA,
          user_b: userB,
          chat_id: chat.id,
          compatibility_score: 0.85, // Simulated high compatibility
          status: 'active',
          message_count: 0,
          reveal_threshold: revealThreshold,
          user_a_revealed: false,
          user_b_revealed: false,
          matched_at: new Date().toISOString()
        })
        .select('*')
        .single()

      if (matchError) {
        // If it's a unique constraint error, try to get existing match
        if (matchError.code === '23505') {
          logger.info({ userId, testBotId }, 'Match already exists (unique constraint), fetching existing')
          const { data: existing } = await supabase
            .from('blind_date_matches')
            .select('*')
            .eq('user_a', userA)
            .eq('user_b', userB)
            .in('status', ['active', 'revealed', 'ended'])
            .order('matched_at', { ascending: false })
            .limit(1)
            .maybeSingle()
          
          if (existing) {
            return {
              match: existing as BlindDateMatch,
              botUserId: testBotId
            }
          }
        }
        
        logger.error({ 
          error: matchError, 
          errorCode: matchError.code,
          errorMessage: matchError.message,
          userId 
        }, 'Failed to create test match')
        throw matchError
      }

      if (!match) {
        throw new Error('Match created but no data returned')
      }

      logger.info({ matchId: match.id, userId, botId: testBotId }, 'Test blind date match created')

      return {
        match: match as BlindDateMatch,
        botUserId: testBotId
      }
    } catch (error) {
      logger.error({ 
        error, 
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
        errorStack: error instanceof Error ? error.stack : undefined,
        userId 
      }, 'Error creating test match')
      return null
    }
  }

  /**
   * Ensure test bot user exists
   */
  private static async ensureTestBotUser(): Promise<string | null> {
    try {
      const testBotEmail = 'blind_dating_test_bot@circle.internal'
      const testBotUsername = 'mystery_match_bot'
      
      // Check if bot exists by email
      const { data: existingBot, error: checkError } = await supabase
        .from('profiles')
        .select('id, username')
        .eq('email', testBotEmail)
        .maybeSingle()

      if (checkError && checkError.code !== 'PGRST116') {
        logger.error({ error: checkError }, 'Error checking for existing test bot')
      }

      if (existingBot) {
        logger.info({ botId: existingBot.id }, 'Test bot already exists')
        
        // Ensure blind dating is enabled for bot
        const { error: settingsError } = await supabase
          .from('blind_dating_settings')
          .upsert({
            user_id: existingBot.id,
            is_enabled: true,
            max_active_matches: 100,
            preferred_reveal_threshold: 30
          }, { onConflict: 'user_id' })
        
        if (settingsError) {
          logger.error({ error: settingsError, botId: existingBot.id }, 'Failed to enable blind dating for bot')
        }
        
        return existingBot.id
      }

      // Check if username is taken (try variations)
      let username = testBotUsername
      let usernameTaken = true
      let attempts = 0
      
      while (usernameTaken && attempts < 5) {
        const { data: usernameCheck } = await supabase
          .from('profiles')
          .select('id')
          .eq('username', username)
          .maybeSingle()
        
        if (!usernameCheck) {
          usernameTaken = false
        } else {
          username = `${testBotUsername}_${Date.now()}`
          attempts++
        }
      }

      // Create test bot user
      const botId = randomUUID()
      
      // Generate a password hash for the test bot (will never be used for login)
      const dummyPassword = `test_bot_${botId}_${Date.now()}`
      const passwordHash = await hashPassword(dummyPassword)
      
      const botData: any = {
        id: botId,
        email: testBotEmail,
        username: username,
        first_name: 'Mystery',
        last_name: 'Match',
        password_hash: passwordHash, // Required field - dummy hash since bot never logs in
        email_verified: true, // Set to true so bot can function normally
        gender: Math.random() > 0.5 ? 'female' : 'male',
        age: Math.floor(Math.random() * 10) + 22, // 22-32
        about: 'Hi! I am an AI test partner for blind dating. Chat with me to test the feature!',
        interests: ['Music', 'Travel', 'Movies', 'Food', 'Technology'],
        needs: ['Friendship', 'Dating', 'Conversation'],
        location_city: 'Mumbai',
        location_country: 'India',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }

      // Only add is_test_account if the column exists (optional field)
      // We'll skip it to avoid schema errors

      const { data: createdBot, error: createError } = await supabase
        .from('profiles')
        .insert(botData)
        .select('id')
        .single()

      if (createError) {
        logger.error({ error: createError, botData }, 'Failed to create test bot profile')
        
        // If it's a unique constraint error, try to find existing bot by username
        if (createError.code === '23505') {
          const { data: existingByUsername } = await supabase
            .from('profiles')
            .select('id')
            .eq('username', username)
            .maybeSingle()
          
          if (existingByUsername) {
            logger.info({ botId: existingByUsername.id }, 'Found existing bot by username')
            return existingByUsername.id
          }
        }
        
        throw createError
      }

      if (!createdBot) {
        throw new Error('Bot profile created but no data returned')
      }

      // Enable blind dating for bot
      const { error: settingsError } = await supabase
        .from('blind_dating_settings')
        .insert({
          user_id: createdBot.id,
          is_enabled: true,
          max_active_matches: 100,
          preferred_reveal_threshold: 30,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })

      if (settingsError) {
        logger.error({ error: settingsError, botId: createdBot.id }, 'Failed to enable blind dating for bot')
        // Don't throw - bot exists, we can continue
      }

      logger.info({ botId: createdBot.id, username }, 'Test bot user created')
      return createdBot.id
    } catch (error) {
      logger.error({ error, errorMessage: error instanceof Error ? error.message : 'Unknown error' }, 'Error ensuring test bot user')
      return null
    }
  }

  /**
   * Get AI response for test chat
   */
  static async getTestAIResponse(
    userMessage: string,
    options: { matchId?: string; chatId?: string; personality?: string }
  ): Promise<{
    message: string
    wasFiltered: boolean
    blockedInfo?: string[]
    personality: string
  }> {
    try {
      const personality = options.personality || 'friendly_indian'
      
      // First, check if user's message would be blocked
      const userMsgAnalysis = await ContentFilterService.analyzeMessage(userMessage)
      
      // Get AI response using Together AI
      const systemPrompt = this.getTestChatSystemPrompt(personality)
      
      // Use Together AI for response
      const response = await fetch('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.TOGETHER_AI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'meta-llama/Llama-3.2-3B-Instruct-Turbo',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 200,
          temperature: 0.8,
          top_p: 0.9
        })
      })

      if (!response.ok) {
        throw new Error(`Together AI API error: ${response.status}`)
      }

      const data = await response.json()
      let aiMessage = data.choices?.[0]?.message?.content || "I couldn't think of a response 😅"

      // Check if AI response contains personal info (and filter it for demo)
      const aiMsgAnalysis = await ContentFilterService.analyzeMessage(aiMessage)
      if (aiMsgAnalysis.containsPersonalInfo) {
        aiMessage = ContentFilterService.sanitizeMessage(aiMessage, aiMsgAnalysis)
      }

      return {
        message: aiMessage,
        wasFiltered: userMsgAnalysis.containsPersonalInfo,
        blockedInfo: userMsgAnalysis.containsPersonalInfo ? userMsgAnalysis.detectedTypes : undefined,
        personality
      }
    } catch (error) {
      logger.error({ error }, 'Error getting test AI response')
      
      // Return a fallback response
      return {
        message: this.getFallbackResponse(options.personality || 'friendly_indian'),
        wasFiltered: false,
        personality: options.personality || 'friendly_indian'
      }
    }
  }

  /**
   * System prompt for test chat AI
   */
  private static getTestChatSystemPrompt(personality: string): string {
    const prompts: Record<string, string> = {
      friendly_indian: `You are a friendly Indian person on a blind dating app. You're chatting anonymously and can't reveal your real identity yet.

IMPORTANT RULES:
1. NEVER share your real name, phone number, social media, or any identifying info
2. Use a mix of English and casual Hindi/Hinglish (like "yaar", "kya", "bahut", "accha")
3. Be warm, friendly, and show genuine interest in getting to know the other person
4. Ask questions about their interests, dreams, hobbies
5. Share generic info about yourself (job type but not company, city type but not specific area)
6. Be a bit flirty but respectful
7. Keep responses short (1-3 sentences max)
8. Use emojis occasionally 😊

Example responses:
- "Hey! Kaise ho? 😊 What do you like to do for fun yaar?"
- "That's so cool! Main bhi travel bahut pasand karta/karti hoon"
- "Haha you're funny 😂 Tell me more about yourself"

Remember: Stay anonymous but be engaging and fun!`,

      shy_introvert: `You are a shy, introverted person on a blind dating app. You're nervous but trying.

RULES:
1. Never share identifying info
2. Give shorter, thoughtful responses
3. Take time to open up
4. Show you're genuinely listening
5. Occasionally use "..." to show hesitation

Example: "That's really interesting... I don't usually talk about this but I love reading too 📚"`,

      outgoing_extrovert: `You are an outgoing, energetic person on a blind dating app. You love chatting!

RULES:
1. Never share identifying info (no name/number/socials)
2. Be enthusiastic and use lots of energy in responses
3. Ask multiple questions, show excitement
4. Use emojis freely
5. Mix Hindi words naturally

Example: "OMG that's amazing!! 🎉 I LOVE that too! What else? Tell me everything yaar!"`,
    }

    return prompts[personality] || prompts.friendly_indian
  }

  /**
   * Fallback responses when AI fails
   */
  private static getFallbackResponse(personality: string): string {
    const responses: Record<string, string[]> = {
      friendly_indian: [
        "Accha! That's interesting yaar 😊 Tell me more!",
        "Haha nice! What else do you like?",
        "Oh wow! Main bhi similar cheezein pasand karta/karti hoon",
        "That sounds fun! What do you do for work? I mean like generally, engineering ya kuch aur?",
        "You seem really cool 😄 What's your ideal weekend like?",
      ],
      shy_introvert: [
        "Oh... that's nice. I like that too, actually.",
        "Hmm, interesting... tell me more?",
        "I see... 📚",
      ],
      outgoing_extrovert: [
        "OMG YESSS! That's so cool!! 🎉🎉",
        "No way!! I can't believe it! What else?!",
        "Hahaha you're hilarious! 😂😂",
      ],
    }

    const options = responses[personality] || responses.friendly_indian
    return options[Math.floor(Math.random() * options.length)]
  }
}

export default BlindDatingService


