import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { CompatibilityService } from './compatibility.service.js'
import { ContentFilterService, type PersonalInfoAnalysis } from './ai/content-filter.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { NotificationService } from './notificationService.js'
import { PushNotificationService } from './pushNotificationService.js'
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
   * Check if two users are compatible for blind dating based on gender
   * 
   * Matching Rules:
   * - ONLY Male <-> Female (opposite gender matching)
   * - Same gender users NEVER match
   * - Unknown/null genders don't match
   */
  private static isGenderCompatible(gender1?: string, gender2?: string): boolean {
    if (!gender1 || !gender2) {
      return false // Don't match if gender is unknown
    }
    
    const g1 = gender1.toLowerCase().trim()
    const g2 = gender2.toLowerCase().trim()
    
    // Helper functions to identify gender categories
    const isMale = (g: string) => g === 'male' || g === 'm' || g === 'man'
    const isFemale = (g: string) => g === 'female' || g === 'f' || g === 'woman'
    
    // ONLY allow opposite gender matching: Male <-> Female
    if ((isMale(g1) && isFemale(g2)) || (isFemale(g1) && isMale(g2))) {
      return true
    }
    
    // All other combinations (same gender, unknown, etc.) are NOT allowed
    return false
  }
  
  /**
   * @deprecated Use isGenderCompatible instead
   */
  private static isOppositeGender(gender1?: string, gender2?: string): boolean {
    return this.isGenderCompatible(gender1, gender2)
  }
  
  /**
   * Check if two users are already friends
   * Returns true if they have an active/accepted friendship
   */
  private static async areUsersFriends(userId1: string, userId2: string): Promise<boolean> {
    try {
      const { data: friendship, error } = await supabase
        .from('friendships')
        .select('id')
        .or(`and(user1_id.eq.${userId1},user2_id.eq.${userId2}),and(user1_id.eq.${userId2},user2_id.eq.${userId1})`)
        .in('status', ['active', 'accepted'])
        .limit(1)
        .maybeSingle()
      
      if (error) {
        logger.error({ error, userId1, userId2 }, 'Error checking friendship status')
        return false
      }
      
      return !!friendship
    } catch (error) {
      logger.error({ error, userId1, userId2 }, 'Error checking friendship status')
      return false
    }
  }
  
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
      // Primary lookup: by chat_id (newer matches should always have this set)
      const { data, error } = await supabase
        .from('blind_date_matches')
        .select('*')
        .eq('chat_id', chatId)
        .maybeSingle()

      if (error && error.code !== 'PGRST116') {
        logger.error({ error, chatId }, 'Failed to get blind date match by chat ID')
        throw error
      }

      if (data) {
        return data as BlindDateMatch
      }

      // Fallback for legacy matches where chat_id was not populated
      // 1. Get chat members (we expect 1:1 chats for blind dating)
      const { data: members, error: membersError } = await supabase
        .from('chat_members')
        .select('user_id')
        .eq('chat_id', chatId)

      if (membersError) {
        logger.error({ error: membersError, chatId }, 'Failed to get chat members for blind date fallback lookup')
        return null
      }

      const userIds = (members || []).map(m => m.user_id)
      if (userIds.length !== 2) {
        // Not a standard 1:1 chat, treat as no blind date match
        return null
      }

      const [u1, u2] = userIds.sort()

      // 2. Look for an active/revealed blind date match between these two users
      const { data: fallbackMatch, error: fallbackError } = await supabase
        .from('blind_date_matches')
        .select('*')
        .or(`and(user_a.eq.${u1},user_b.eq.${u2}),and(user_a.eq.${u2},user_b.eq.${u1})`)
        .in('status', ['active', 'revealed'])
        .order('matched_at', { ascending: false })
        .maybeSingle()

      if (fallbackError && fallbackError.code !== 'PGRST116') {
        logger.error({ error: fallbackError, chatId, u1, u2 }, 'Failed fallback blind date lookup by users')
        return null
      }

      if (!fallbackMatch) {
        return null
      }

      // 3. Best-effort: backfill chat_id on the legacy match so future lookups are fast
      if (!fallbackMatch.chat_id) {
        try {
          await supabase
            .from('blind_date_matches')
            .update({ chat_id: chatId })
            .eq('id', fallbackMatch.id)
          logger.info({ matchId: fallbackMatch.id, chatId, u1, u2 }, 'Backfilled chat_id on blind date match')
        } catch (updateError) {
          logger.error({ error: updateError, matchId: fallbackMatch.id, chatId }, 'Failed to backfill chat_id on blind date match')
        }
      }

      return fallbackMatch as BlindDateMatch
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

      // Check if user has reached max active matches (allow multiple, default 3)
      const activeMatches = await this.getActiveMatches(userId)
      if (activeMatches.length >= settings.max_active_matches) {
        logger.info({ userId, activeMatches: activeMatches.length, max: settings.max_active_matches }, 'User has reached max active blind dates')
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

      // Get users already in active matches with this user (to exclude)
      const { data: existingMatches } = await supabase
        .from('blind_date_matches')
        .select('user_a, user_b')
        .or(`user_a.eq.${userId},user_b.eq.${userId}`)
        .in('status', ['active', 'revealed'])
      
      const excludedUserIds = new Set<string>([userId])
      ;(existingMatches || []).forEach(m => {
        excludedUserIds.add(m.user_a)
        excludedUserIds.add(m.user_b)
      })

      logger.info({ userId, excludedCount: excludedUserIds.size - 1 }, 'Finding eligible users for blind dating')

      // Try RPC first, but use robust fallback
      let eligibleUsers: Array<{ user_id: string; compatibility_data: any }> = []
      
      const { data: rpcUsers, error: eligibleError } = await supabase
        .rpc('find_blind_dating_eligible_users', {
          exclude_user_id: userId,
          max_results: 100
        })
      
      if (eligibleError) {
        logger.warn({ error: eligibleError, userId }, 'RPC failed, using fallback query')
      } else if (rpcUsers && rpcUsers.length > 0) {
        eligibleUsers = rpcUsers
        logger.info({ userId, count: eligibleUsers.length }, 'Found eligible users via RPC')
      }

      // If RPC returned no results or failed, use fallback
      if (eligibleUsers.length === 0) {
        logger.info({ userId }, 'Using fallback query for eligible users')
        
        // Get all users with blind dating enabled
        const { data: enabledSettings, error: settingsError } = await supabase
          .from('blind_dating_settings')
          .select('user_id, max_active_matches')
          .eq('is_enabled', true)
        
        if (settingsError) {
          logger.error({ error: settingsError, userId }, 'Failed to get blind dating settings')
          return null
        }

        const enabledUserIds = (enabledSettings || [])
          .map(s => s.user_id)
          .filter(id => !excludedUserIds.has(id))
        
        if (enabledUserIds.length === 0) {
          logger.info({ userId }, 'No other users have blind dating enabled')
          return null
        }

        // Get profiles of enabled users
        const { data: profiles, error: profilesError } = await supabase
          .from('profiles')
          .select('id, age, gender, interests, needs, location_city, location_country')
          .in('id', enabledUserIds)
          .is('deleted_at', null)
          .limit(100)
        
        if (profilesError) {
          logger.error({ error: profilesError, userId }, 'Failed to get profiles')
          return null
        }

        // Filter out suspended/invisible users, check max matches, and enforce gender compatibility
        const validProfiles: typeof profiles = []
        const userGender = userProfile.gender?.toLowerCase()
        
        for (const profile of (profiles || [])) {
          // IMPORTANT: Only match compatible genders (opposite genders only)
          const candidateGender = profile.gender?.toLowerCase()
          if (!this.isGenderCompatible(userGender, candidateGender)) {
            logger.debug({ userId, candidateId: profile.id, userGender, candidateGender }, 'Skipping incompatible gender candidate')
            continue
          }
          
          // Check if candidate has reached their max active matches
          const candidateSettings = enabledSettings?.find(s => s.user_id === profile.id)
          const maxMatches = candidateSettings?.max_active_matches || 3
          
          const { count } = await supabase
            .from('blind_date_matches')
            .select('*', { count: 'exact', head: true })
            .or(`user_a.eq.${profile.id},user_b.eq.${profile.id}`)
            .in('status', ['active', 'revealed'])
          
          // Include candidates who haven't reached their max
          if ((count || 0) < maxMatches) {
            validProfiles.push(profile)
          } else {
            logger.debug({ userId, candidateId: profile.id, activeMatches: count, max: maxMatches }, 'Skipping candidate - reached max active blind dates')
          }
        }

        eligibleUsers = validProfiles.map(p => ({
          user_id: p.id,
          compatibility_data: p
        }))

        logger.info({ userId, count: eligibleUsers.length }, 'Found eligible users via fallback')
      }

      if (eligibleUsers.length === 0) {
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
   * Find a match for a user, excluding specific user IDs (used for batch matching)
   * This ensures each user only gets ONE match per matching run
   */
  static async findMatchExcluding(userId: string, excludeUserIds: Set<string>): Promise<BlindDateMatch | null> {
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
        logger.info({ userId, activeMatches: activeMatches.length, max: settings.max_active_matches }, 'User has reached max active blind dates')
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

      // Get users already in active matches with this user (to exclude)
      const { data: existingMatches } = await supabase
        .from('blind_date_matches')
        .select('user_a, user_b')
        .or(`user_a.eq.${userId},user_b.eq.${userId}`)
        .in('status', ['active', 'revealed'])
      
      const excludedUserIds = new Set<string>([userId, ...excludeUserIds])
      ;(existingMatches || []).forEach(m => {
        excludedUserIds.add(m.user_a)
        excludedUserIds.add(m.user_b)
      })

      logger.info({ userId, excludedCount: excludedUserIds.size - 1 }, 'Finding eligible users (with exclusions)')

      // Get all users with blind dating enabled
      const { data: enabledSettings, error: settingsError } = await supabase
        .from('blind_dating_settings')
        .select('user_id, max_active_matches')
        .eq('is_enabled', true)
      
      if (settingsError) {
        logger.error({ error: settingsError, userId }, 'Failed to get blind dating settings')
        return null
      }

      const enabledUserIds = (enabledSettings || [])
        .map(s => s.user_id)
        .filter(id => !excludedUserIds.has(id))
      
      if (enabledUserIds.length === 0) {
        logger.info({ userId }, 'No other users available for matching')
        return null
      }

      // Get profiles of enabled users
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, age, gender, interests, needs, location_city, location_country')
        .in('id', enabledUserIds)
        .is('deleted_at', null)
        .limit(100)
      
      if (profilesError) {
        logger.error({ error: profilesError, userId }, 'Failed to get profiles')
        return null
      }

      // Filter for gender compatibility and max matches
      const validProfiles: typeof profiles = []
      const userGender = userProfile.gender?.toLowerCase()
      
      for (const profile of (profiles || [])) {
        const candidateGender = profile.gender?.toLowerCase()
        if (!this.isGenderCompatible(userGender, candidateGender)) {
          continue
        }
        
        // Check if candidate has reached their max active matches
        const candidateSettings = enabledSettings?.find(s => s.user_id === profile.id)
        const maxMatches = candidateSettings?.max_active_matches || 3
        
        const { count } = await supabase
          .from('blind_date_matches')
          .select('*', { count: 'exact', head: true })
          .or(`user_a.eq.${profile.id},user_b.eq.${profile.id}`)
          .in('status', ['active', 'revealed'])
        
        if ((count || 0) < maxMatches) {
          validProfiles.push(profile)
        }
      }

      const eligibleUsers = validProfiles.map(p => ({
        user_id: p.id,
        compatibility_data: p
      }))

      if (eligibleUsers.length === 0) {
        logger.info({ userId }, 'No eligible users found for blind dating')
        return null
      }

      return this.createMatchFromCandidates(userId, userProfile, eligibleUsers, settings)
    } catch (error) {
      logger.error({ error, userId }, 'Error finding blind date match with exclusions')
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
      const userGender = userProfile.gender?.toLowerCase()
      
      // Filter candidates to only compatible genders and score them
      const scoredCandidates = candidates
        .map(candidate => {
          const data = typeof candidate.compatibility_data === 'string'
            ? JSON.parse(candidate.compatibility_data)
            : candidate.compatibility_data
          
          const candidateGender = data.gender?.toLowerCase()
          
          // CRITICAL: Only match compatible genders
          if (!this.isGenderCompatible(userGender, candidateGender)) {
            return null // Skip incompatible gender candidates
          }
          
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
          
          // Add a base score to ensure matches happen even with low compatibility
          // This ensures users get matched even if they have few common interests
          const baseScore = 5 // Minimum base score for any potential match
          const adjustedScore = Math.max(compatibility.score, baseScore)
          
          return {
            userId: candidate.user_id,
            score: adjustedScore,
            rawScore: compatibility.score,
            compatibility
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null) // Remove null entries (same-gender)

      // Sort by score (highest first)
      scoredCandidates.sort((a, b) => b.score - a.score)

      logger.info({
        userId,
        candidateCount: scoredCandidates.length,
        topScores: scoredCandidates.slice(0, 5).map(c => ({ userId: c.userId, score: c.score, rawScore: c.rawScore }))
      }, 'Scored candidates for blind dating')

      // Find the best match that is NOT already a friend
      let bestMatch = null
      for (const candidate of scoredCandidates) {
        // Check if they are already friends - skip if so
        const areFriends = await this.areUsersFriends(userId, candidate.userId)
        if (areFriends) {
          logger.debug({ userId, candidateId: candidate.userId }, 'Skipping candidate - already friends')
          continue
        }
        bestMatch = candidate
        break
      }
      
      if (!bestMatch) {
        logger.info({ userId, userGender }, 'No compatible candidates available for matching (all are friends or incompatible)')
        return null
      }
      
      // Log if we're matching with low compatibility (for monitoring)
      if (bestMatch.rawScore < 10) {
        logger.info({ 
          userId, 
          matchUserId: bestMatch.userId,
          rawScore: bestMatch.rawScore,
          adjustedScore: bestMatch.score 
        }, 'Creating match with low compatibility score (this is OK for blind dating)')
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

      // Send push notifications to both users
      await Promise.all([
        PushNotificationService.sendBlindDateMatchNotification(
          userId,
          match.id,
          match.chat_id || ''
        ),
        PushNotificationService.sendBlindDateMatchNotification(
          otherUserId,
          match.id,
          match.chat_id || ''
        )
      ])
      
      logger.info({ matchId: match.id, userId, otherUserId }, 'Sent blind date match push notifications')

      // Send anonymized email notifications to both users if emails are available
      const { default: EmailService }: any = await import('./emailService.js')
      const { data: emailProfiles } = await supabase
        .from('profiles')
        .select('id, email, first_name')
        .in('id', [userId, otherUserId])

      const emailMap = new Map<string, { email: string; first_name: string | null }>()
      ;(emailProfiles || []).forEach((p: any) => {
        if (p.email) {
          emailMap.set(p.id, { email: p.email, first_name: p.first_name })
        }
      })

      const anonymizedForUser = userProfile
      const anonymizedForOther = otherProfile

      const userEmailInfo = emailMap.get(userId)
      if (userEmailInfo && anonymizedForUser) {
        const html = `
          <p>Hi ${userEmailInfo.first_name || 'there'},</p>
          <p>We just found you a new blind date match on Circle.</p>
          <p>For now, their identity is anonymous, but here are a few hints:</p>
          <ul>
            <li>Name: ${anonymizedForUser.first_name} ${anonymizedForUser.last_name}</li>
            ${anonymizedForUser.age ? `<li>Age: ${anonymizedForUser.age}</li>` : ''}
            ${anonymizedForUser.location_city ? `<li>City: ${anonymizedForUser.location_city}</li>` : ''}
          </ul>
          <p>Open the Circle app to start chatting. Once the vibe is right and both of you agree, you can reveal your identities.</p>
        `.trim()

        await EmailService.sendEmail({
          to: userEmailInfo.email,
          subject: 'New Blind Date match on Circle 🎭',
          html,
        })
      }

      const otherEmailInfo = emailMap.get(otherUserId)
      if (otherEmailInfo && anonymizedForOther) {
        const html = `
          <p>Hi ${otherEmailInfo.first_name || 'there'},</p>
          <p>We just found you a new blind date match on Circle.</p>
          <p>For now, their identity is anonymous, but here are a few hints:</p>
          <ul>
            <li>Name: ${anonymizedForOther.first_name} ${anonymizedForOther.last_name}</li>
            ${anonymizedForOther.age ? `<li>Age: ${anonymizedForOther.age}</li>` : ''}
            ${anonymizedForOther.location_city ? `<li>City: ${anonymizedForOther.location_city}</li>` : ''}
          </ul>
          <p>Open the Circle app to start chatting. Once the vibe is right and both of you agree, you can reveal your identities.</p>
        `.trim()

        await EmailService.sendEmail({
          to: otherEmailInfo.email,
          subject: 'New Blind Date match on Circle 🎭',
          html,
        })
      }
    } catch (error) {
      logger.error({ error, userId, otherUserId }, 'Failed to notify users about blind date match')
    }
  }

  /**
   * Check if a chat is a blind date chat
   */
  static async isBlindDateChat(chatId: string): Promise<boolean> {
    try {
      const { data, error } = await supabase
        .from('blind_date_matches')
        .select('id')
        .eq('chat_id', chatId)
        .in('status', ['active', 'revealed'])
        .limit(1)
      
      if (error) {
        logger.error({ error, chatId }, 'Error checking if chat is blind date')
        return false
      }
      
      return Array.isArray(data) ? data.length > 0 : !!data
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
   * Once threshold is reached, reveal is always available
   */
  static isRevealAvailable(match: BlindDateMatch): boolean {
    // Already revealed - no need to reveal again
    if (match.status === 'revealed') {
      return false
    }
    
    // Match must be active
    if (match.status !== 'active') {
      return false
    }

    const messageCount = match.message_count
    const threshold = match.reveal_threshold

    // Once threshold is reached, reveal is always available
    // This is more user-friendly than requiring exact checkpoints
    return messageCount >= threshold
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
        logger.error({ matchId, requestingUserId }, '[BlindDate] Reveal failed - match not found')
        return { success: false, bothRevealed: false, message: 'Match not found' }
      }

      logger.info({ 
        matchId, 
        requestingUserId, 
        status: match.status,
        messageCount: match.message_count,
        threshold: match.reveal_threshold,
        user_a: match.user_a,
        user_b: match.user_b,
        user_a_revealed: match.user_a_revealed,
        user_b_revealed: match.user_b_revealed
      }, '[BlindDate] Processing reveal request')

      // Allow reveal for both active and already-revealed matches (for the second user)
      if (match.status !== 'active' && match.status !== 'revealed') {
        return { success: false, bothRevealed: false, message: 'Match is not active' }
      }

      // Check if user already revealed
      const isUserA = match.user_a === requestingUserId
      const isUserB = match.user_b === requestingUserId
      
      if (!isUserA && !isUserB) {
        return { success: false, bothRevealed: false, message: 'You are not part of this match' }
      }

      const alreadyRevealed = isUserA ? match.user_a_revealed : match.user_b_revealed
      if (alreadyRevealed) {
        // User already revealed, just return success
        const bothRevealed = match.user_a_revealed && match.user_b_revealed
        return { 
          success: true, 
          bothRevealed, 
          message: bothRevealed ? 'Both identities revealed!' : 'You have already revealed your identity. Waiting for the other person.' 
        }
      }

      if (!this.isRevealAvailable(match)) {
        const messagesNeeded = Math.max(0, match.reveal_threshold - match.message_count)
        return { 
          success: false, 
          bothRevealed: false, 
          message: `Need ${messagesNeeded} more messages before revealing` 
        }
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

        // Create automatic friendship FIRST before emitting events
        const friendshipCreated = await this.createFriendshipForRevealedMatch(match.user_a, match.user_b)
        logger.info({ matchId, userA: match.user_a, userB: match.user_b, friendshipCreated }, '[BlindDate] Friendship creation result')

        // Emit to user A with user B's profile
        emitToUser(match.user_a, 'blind_date:revealed', {
          matchId,
          chatId: match.chat_id,
          otherUser: profile2,
          otherUserId: match.user_b,
          bothRevealed: true,
          friendshipCreated,
          message: friendshipCreated 
            ? 'Identity revealed! You are now friends and can see each other\'s full profile.'
            : 'Identity revealed! You can now see each other\'s full profile.'
        })

        // Emit to user B with user A's profile
        emitToUser(match.user_b, 'blind_date:revealed', {
          matchId,
          chatId: match.chat_id,
          otherUser: profile1,
          otherUserId: match.user_a,
          bothRevealed: true,
          friendshipCreated,
          message: friendshipCreated 
            ? 'Identity revealed! You are now friends and can see each other\'s full profile.'
            : 'Identity revealed! You can now see each other\'s full profile.'
        })
      } else {
        // First user revealed - notify other user
        const revealingUserProfile = await this.getAnonymizedProfile(requestingUserId, false)
        
        emitToUser(otherUserId, 'blind_date:reveal_requested', {
          matchId,
          chatId: match.chat_id,
          revealedByUserId: requestingUserId,
          revealedByProfile: revealingUserProfile,
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
   * Uses the same schema as friend request acceptance:
   * - user1_id: smaller UUID
   * - user2_id: larger UUID  
   * - sender_id: who initiated (userA in this case - first to reveal)
   * - status: 'accepted' or 'active'
   */
  private static async createFriendshipForRevealedMatch(userA: string, userB: string): Promise<boolean> {
    try {
      const smallerId = userA < userB ? userA : userB
      const largerId = userA < userB ? userB : userA
      
      logger.info({ userA, userB, smallerId, largerId }, '[BlindDate] Attempting to create friendship')
      
      // Check if friendship already exists (check all statuses)
      const { data: existing, error: checkError } = await supabase
        .from('friendships')
        .select('id, status')
        .eq('user1_id', smallerId)
        .eq('user2_id', largerId)
        .maybeSingle()

      if (checkError && checkError.code !== 'PGRST116') {
        logger.error({ checkError, userA, userB }, '[BlindDate] Error checking existing friendship')
      }

      if (existing) {
        logger.info({ userA, userB, existingStatus: existing.status }, '[BlindDate] Friendship already exists')
        // If it exists but not active/accepted, update it
        if (existing.status !== 'active' && existing.status !== 'accepted') {
          const { error: updateError } = await supabase
            .from('friendships')
            .update({ 
              status: 'accepted', 
              updated_at: new Date().toISOString() 
            })
            .eq('id', existing.id)
          
          if (updateError) {
            logger.error({ updateError, userA, userB }, '[BlindDate] Error updating friendship status')
            return false
          }
          logger.info({ userA, userB }, '[BlindDate] Updated existing friendship to accepted')
        }
        return true
      }

      // Create new friendship with all required fields
      const now = new Date().toISOString()
      const { data: newFriendship, error: insertError } = await supabase
        .from('friendships')
        .insert({
          user1_id: smallerId,
          user2_id: largerId,
          sender_id: userA, // First user to reveal is considered the "sender"
          status: 'accepted', // Use 'accepted' to match friend request acceptance
          created_at: now,
          updated_at: now
        })
        .select('id')
        .single()
      
      if (insertError) {
        // Check if it's a duplicate key error (23505) - that's okay
        if (insertError.code === '23505') {
          logger.info({ userA, userB }, '[BlindDate] Friendship already exists (duplicate key)')
          return true
        }
        logger.error({ insertError, code: insertError.code, message: insertError.message, details: insertError.details }, '[BlindDate] Error inserting friendship')
        return false
      }
      
      logger.info({ userA, userB, friendshipId: newFriendship?.id }, '[BlindDate] Successfully created friendship')
      return true
    } catch (error) {
      logger.error({ error, userA, userB }, '[BlindDate] Failed to create friendship for revealed match')
      return false
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
        // Match not found - allow message (fail open)
        return { allowed: true, originalMessage: message }
      }

      // CRITICAL: If identities are revealed, allow ALL messages without any filtering
      // Users can share any information once revealed
      if (match.status === 'revealed') {
        return { allowed: true, originalMessage: message }
      }

      // Fast quick check first (pattern-based, no AI call)
      // This catches 90% of cases instantly without AI delay
      if (!ContentFilterService.quickCheck(message)) {
        // No obvious personal info patterns - allow immediately
        return { allowed: true, originalMessage: message }
      }

      // Only if quickCheck found potential issues, do AI analysis
      // This is the only part that might take time, but it's only for suspicious messages
      const analysis = await ContentFilterService.analyzeMessage(message, {
        messageCount: match.message_count
      })

      if (!analysis.containsPersonalInfo) {
        // AI confirms no personal info - allow
        return { allowed: true, originalMessage: message, analysis }
      }

      // Message contains personal info - block it
      const blockedReason = `Personal information detected: ${analysis.detectedTypes.join(', ')}`
      
      // Store blocked message (fire and forget - don't wait to keep it real-time)
      // This runs in background and doesn't block the response
      Promise.resolve(supabase
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
        }))
        .then(async (result) => {
          const { error: insertError } = await result
          if (insertError) {
            logger.error({ error: insertError, matchId, senderId }, 'Failed to log blocked message')
          } else {
            logger.info({ 
              matchId, 
              senderId, 
              detectedTypes: analysis.detectedTypes 
            }, 'Message blocked for personal info in blind date')
          }
        })
        .catch((err: any) => {
          logger.error({ error: err, matchId, senderId }, 'Failed to log blocked message')
        })

      return {
        allowed: false,
        originalMessage: message,
        filteredMessage: ContentFilterService.sanitizeMessage(message, analysis),
        blockedReason,
        analysis
      }
    } catch (error) {
      logger.error({ error, matchId, senderId }, 'Error filtering message')
      // In case of error, allow the message but log it (fail open for real-time)
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
    hasRevealedSelf: boolean
    otherHasRevealed: boolean
    matchId?: string
  } | null> {
    try {
      const match = await this.getMatchByChatId(chatId)
      
      if (!match) {
        return { 
          isBlindDate: false, 
          canReveal: false, 
          messagesUntilReveal: 0,
          hasRevealedSelf: false,
          otherHasRevealed: false
        }
      }

      const isUserA = match.user_a === userId
      const otherUserId = isUserA ? match.user_b : match.user_a
      
      // Determine reveal status for each user
      const hasRevealedSelf = isUserA ? match.user_a_revealed : match.user_b_revealed
      const otherHasRevealed = isUserA ? match.user_b_revealed : match.user_a_revealed
      
      // Show revealed profile if match is fully revealed OR if the other user has revealed
      const showRevealedProfile = match.status === 'revealed' || otherHasRevealed

      const otherUserProfile = await this.getAnonymizedProfile(otherUserId, showRevealedProfile)
      
      // Allow reveal if threshold is met (more permissive - once threshold is reached, always allow)
      const canReveal = this.isRevealAvailable(match) && !hasRevealedSelf
      const messagesUntilReveal = this.getMessagesUntilReveal(match)

      logger.info({ 
        chatId, 
        matchId: match.id,
        userId, 
        isUserA,
        hasRevealedSelf, 
        otherHasRevealed,
        canReveal,
        messageCount: match.message_count,
        threshold: match.reveal_threshold,
        status: match.status
      }, '[BlindDate] getChatBlindDateStatus result')

      return {
        isBlindDate: true,
        match,
        matchId: match.id,
        otherUserProfile: otherUserProfile || undefined,
        canReveal,
        messagesUntilReveal,
        hasRevealedSelf,
        otherHasRevealed
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
      
      // Get users already processed today
      const { data: processedToday } = await supabase
        .from('blind_date_daily_queue')
        .select('user_id')
        .eq('scheduled_date', today)
        .eq('status', 'matched')
      
      const processedUserIds = new Set((processedToday || []).map(u => u.user_id))
      
      // Get all users with blind dating enabled
      const { data: allEnabledUsers, error } = await supabase
        .from('blind_dating_settings')
        .select('user_id')
        .eq('is_enabled', true)
        .eq('auto_match', true)
      
      // Filter out already processed users
      const enabledUsers = (allEnabledUsers || []).filter(u => !processedUserIds.has(u.user_id))
      
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

  /**
   * Force run matching for all eligible users (admin function)
   * This bypasses the daily queue and tries to match everyone
   */
  static async forceMatchAllUsers(): Promise<{ 
    processed: number; 
    matched: number; 
    errors: number;
    details: Array<{ userId: string; status: string; matchId?: string; error?: string }>
  }> {
    const stats = { 
      processed: 0, 
      matched: 0, 
      errors: 0,
      details: [] as Array<{ userId: string; status: string; matchId?: string; error?: string }>
    }
    
    try {
      // Get all users with blind dating enabled
      const { data: enabledUsers, error } = await supabase
        .from('blind_dating_settings')
        .select('user_id, max_active_matches')
        .eq('is_enabled', true)
      
      if (error) {
        logger.error({ error }, 'Failed to get enabled users for force matching')
        return stats
      }

      logger.info({ userCount: enabledUsers?.length || 0 }, '🚀 Force matching all blind dating users')

      // Track users who got matched in THIS run to ensure 1:1 per run
      const matchedInThisRun = new Set<string>()
      
      // Process each user
      for (const user of (enabledUsers || [])) {
        stats.processed++
        
        // Skip if user was already matched with someone in this run
        if (matchedInThisRun.has(user.user_id)) {
          stats.details.push({ 
            userId: user.user_id, 
            status: 'skipped', 
            error: 'Already matched with someone in this run (1 match per run)' 
          })
          continue
        }
        
        try {
          // Check if user has reached max active matches
          const activeMatches = await this.getActiveMatches(user.user_id)
          const maxMatches = user.max_active_matches || 3
          
          if (activeMatches.length >= maxMatches) {
            stats.details.push({ 
              userId: user.user_id, 
              status: 'skipped', 
              error: `Already has ${activeMatches.length}/${maxMatches} active matches` 
            })
            continue
          }
          
          // Try to find a match (excluding users already matched in this run)
          const match = await this.findMatchExcluding(user.user_id, matchedInThisRun)
          
          if (match) {
            stats.matched++
            // Mark both users as matched in this run
            matchedInThisRun.add(user.user_id)
            matchedInThisRun.add(match.user_a === user.user_id ? match.user_b : match.user_a)
            
            stats.details.push({ 
              userId: user.user_id, 
              status: 'matched', 
              matchId: match.id 
            })
            logger.info({ userId: user.user_id, matchId: match.id }, '✅ Match created')
          } else {
            stats.details.push({ 
              userId: user.user_id, 
              status: 'no_match', 
              error: 'No eligible candidates found' 
            })
          }
        } catch (error) {
          stats.errors++
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          stats.details.push({ 
            userId: user.user_id, 
            status: 'error', 
            error: errorMsg 
          })
          logger.error({ error, userId: user.user_id }, 'Error in force matching')
        }
      }

      logger.info(stats, '🏁 Force matching completed')
      return stats
    } catch (error) {
      logger.error({ error }, 'Error in force match all users')
      return stats
    }
  }

  /**
   * Run detailed matching for all users with comprehensive logging
   * Returns detailed information about why each user was matched or not
   */
  static async runDetailedMatchingForAll(): Promise<{
    summary: {
      totalUsers: number;
      processed: number;
      matched: number;
      skipped: number;
      noMatch: number;
      errors: number;
      timestamp: string;
    };
    results: Array<{
      userId: string;
      userName: string;
      userEmail: string;
      status: 'matched' | 'skipped' | 'no_match' | 'error' | 'disabled';
      reason: string;
      details: {
        blindDatingEnabled?: boolean;
        activeMatchesCount?: number;
        maxActiveMatches?: number;
        eligibleCandidatesCount?: number;
        matchedWithUserId?: string;
        matchedWithUserName?: string;
        compatibilityScore?: number;
        matchId?: string;
        candidatesExcludedReasons?: string[];
      };
      timestamp: string;
    }>;
  }> {
    const timestamp = new Date().toISOString()
    const results: Array<any> = []
    const summary = {
      totalUsers: 0,
      processed: 0,
      matched: 0,
      skipped: 0,
      noMatch: 0,
      errors: 0,
      timestamp
    }

    try {
      // Get ALL users (not just enabled ones) to show complete picture
      const { data: allUsers, error: usersError } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, email, age, gender, interests, needs')
        .is('deleted_at', null)
        .order('created_at', { ascending: false })

      if (usersError) {
        logger.error({ error: usersError }, 'Failed to get users for detailed matching')
        throw usersError
      }

      summary.totalUsers = allUsers?.length || 0

      // Get all blind dating settings
      const { data: allSettings } = await supabase
        .from('blind_dating_settings')
        .select('*')

      const settingsMap = new Map((allSettings || []).map(s => [s.user_id, s]))

      // Get all active matches
      const { data: allActiveMatches } = await supabase
        .from('blind_date_matches')
        .select('user_a, user_b, status')
        .in('status', ['active', 'revealed'])

      // Build a map of user -> active match partners
      const activeMatchPartnersMap = new Map<string, Set<string>>()
      for (const match of (allActiveMatches || [])) {
        if (!activeMatchPartnersMap.has(match.user_a)) {
          activeMatchPartnersMap.set(match.user_a, new Set())
        }
        if (!activeMatchPartnersMap.has(match.user_b)) {
          activeMatchPartnersMap.set(match.user_b, new Set())
        }
        activeMatchPartnersMap.get(match.user_a)!.add(match.user_b)
        activeMatchPartnersMap.get(match.user_b)!.add(match.user_a)
      }

      // Count active matches per user
      const activeMatchCountMap = new Map<string, number>()
      for (const match of (allActiveMatches || [])) {
        activeMatchCountMap.set(match.user_a, (activeMatchCountMap.get(match.user_a) || 0) + 1)
        activeMatchCountMap.set(match.user_b, (activeMatchCountMap.get(match.user_b) || 0) + 1)
      }

      logger.info({ totalUsers: summary.totalUsers }, '🔍 Starting detailed matching analysis')

      // Process each user
      for (const user of (allUsers || [])) {
        const settings = settingsMap.get(user.id)
        const activeMatchCount = activeMatchCountMap.get(user.id) || 0
        const maxMatches = settings?.max_active_matches || 3
        const activePartners = activeMatchPartnersMap.get(user.id) || new Set()

        const result: any = {
          userId: user.id,
          userName: `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'Unknown',
          userEmail: user.email || 'No email',
          status: 'pending',
          reason: '',
          details: {
            blindDatingEnabled: settings?.is_enabled || false,
            activeMatchesCount: activeMatchCount,
            maxActiveMatches: maxMatches
          },
          timestamp
        }

        // Check if blind dating is enabled
        if (!settings?.is_enabled) {
          result.status = 'disabled'
          result.reason = 'Blind dating is not enabled for this user'
          results.push(result)
          continue
        }

        summary.processed++

        // Check if at max matches
        if (activeMatchCount >= maxMatches) {
          result.status = 'skipped'
          result.reason = `User has reached maximum active matches (${activeMatchCount}/${maxMatches})`
          summary.skipped++
          results.push(result)
          continue
        }

        // Find eligible candidates for this user
        const eligibleCandidates: Array<{
          userId: string;
          userName: string;
          score: number;
          excluded: boolean;
          excludeReason?: string;
        }> = []

        for (const candidate of (allUsers || [])) {
          if (candidate.id === user.id) continue

          const candidateSettings = settingsMap.get(candidate.id)
          const candidateActiveCount = activeMatchCountMap.get(candidate.id) || 0
          const candidateMaxMatches = candidateSettings?.max_active_matches || 3

          let excluded = false
          let excludeReason = ''

          // CRITICAL: Check gender compatibility first
          const userGender = user.gender?.toLowerCase()
          const candidateGender = candidate.gender?.toLowerCase()
          
          if (!this.isGenderCompatible(userGender, candidateGender)) {
            excluded = true
            if (!userGender || !candidateGender) {
              excludeReason = 'Gender not specified'
            } else {
              excludeReason = 'Not compatible (gender preference)'
            }
          }
          // Check if candidate has blind dating enabled
          else if (!candidateSettings?.is_enabled) {
            excluded = true
            excludeReason = 'Blind dating not enabled'
          }
          // Check if already matched with this user
          else if (activePartners.has(candidate.id)) {
            excluded = true
            excludeReason = 'Already in active match with this user'
          }
          // Check if candidate is at max matches
          else if (candidateActiveCount >= candidateMaxMatches) {
            excluded = true
            excludeReason = `At max matches (${candidateActiveCount}/${candidateMaxMatches})`
          }

          // Calculate compatibility score
          const compatibility = CompatibilityService.calculateEnhancedCompatibility(
            { age: user.age, interests: user.interests, needs: user.needs },
            { age: candidate.age, interests: candidate.interests, needs: candidate.needs }
          )

          eligibleCandidates.push({
            userId: candidate.id,
            userName: `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim(),
            score: compatibility.score,
            excluded,
            excludeReason
          })
        }

        // Filter to only eligible candidates
        const validCandidates = eligibleCandidates.filter(c => !c.excluded)
        result.details.eligibleCandidatesCount = validCandidates.length
        result.details.candidatesExcludedReasons = eligibleCandidates
          .filter(c => c.excluded)
          .slice(0, 5)
          .map(c => `${c.userName}: ${c.excludeReason}`)

        if (validCandidates.length === 0) {
          result.status = 'no_match'
          
          // Determine specific reason
          const allGenderIncompatible = eligibleCandidates.every(c => c.excludeReason?.includes('Gender') || c.excludeReason?.includes('compatible'))
          const allDisabled = eligibleCandidates.every(c => c.excludeReason === 'Blind dating not enabled')
          const allAlreadyMatched = eligibleCandidates.every(c => c.excludeReason?.includes('Already in active match'))
          const allAtMax = eligibleCandidates.every(c => c.excludeReason?.includes('At max matches'))
          
          if (allUsers!.length <= 1) {
            result.reason = 'No other users in the system'
          } else if (allGenderIncompatible) {
            result.reason = 'No compatible users available with blind dating enabled'
          } else if (allDisabled) {
            result.reason = 'No compatible users have blind dating enabled'
          } else if (allAlreadyMatched) {
            result.reason = 'Already matched with all compatible users'
          } else if (allAtMax) {
            result.reason = 'All compatible users are at their maximum match limit'
          } else {
            result.reason = `No eligible candidates (${eligibleCandidates.length} users checked, all excluded)`
          }
          
          summary.noMatch++
          results.push(result)
          continue
        }

        // Sort by score and pick best match
        validCandidates.sort((a, b) => b.score - a.score)
        const bestCandidate = validCandidates[0]

        try {
          // Create the match
          const match = await this.findMatch(user.id)
          
          if (match) {
            result.status = 'matched'
            result.reason = `Matched based on compatibility score of ${bestCandidate.score.toFixed(1)}`
            result.details.matchedWithUserId = bestCandidate.userId
            result.details.matchedWithUserName = bestCandidate.userName
            result.details.compatibilityScore = bestCandidate.score
            result.details.matchId = match.id
            summary.matched++
            
            // Update the active partners map to prevent double matching
            if (!activeMatchPartnersMap.has(user.id)) {
              activeMatchPartnersMap.set(user.id, new Set())
            }
            if (!activeMatchPartnersMap.has(bestCandidate.userId)) {
              activeMatchPartnersMap.set(bestCandidate.userId, new Set())
            }
            activeMatchPartnersMap.get(user.id)!.add(bestCandidate.userId)
            activeMatchPartnersMap.get(bestCandidate.userId)!.add(user.id)
            
            // Update match counts
            activeMatchCountMap.set(user.id, (activeMatchCountMap.get(user.id) || 0) + 1)
            activeMatchCountMap.set(bestCandidate.userId, (activeMatchCountMap.get(bestCandidate.userId) || 0) + 1)
          } else {
            result.status = 'no_match'
            result.reason = 'Match creation failed - candidate may have been matched by another process'
            summary.noMatch++
          }
        } catch (error) {
          result.status = 'error'
          result.reason = error instanceof Error ? error.message : 'Unknown error during match creation'
          summary.errors++
        }

        results.push(result)
      }

      logger.info(summary, '🏁 Detailed matching completed')

      return { summary, results }
    } catch (error) {
      logger.error({ error }, 'Error in detailed matching')
      throw error
    }
  }

  /**
   * Get diagnostic info about blind dating eligibility
   */
  static async getDiagnostics(): Promise<{
    totalUsers: number;
    usersWithBlindDatingEnabled: number;
    usersWithAutoMatch: number;
    totalActiveMatches: number;
    usersAtMaxMatches: number;
    eligibleForNewMatches: number;
    recentMatches: number;
  }> {
    try {
      // Total users
      const { count: totalUsers } = await supabase
        .from('profiles')
        .select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
      
      // Users with blind dating enabled
      const { data: enabledSettings } = await supabase
        .from('blind_dating_settings')
        .select('user_id, is_enabled, auto_match, max_active_matches')
        .eq('is_enabled', true)
      
      const usersWithBlindDatingEnabled = enabledSettings?.length || 0
      const usersWithAutoMatch = enabledSettings?.filter(s => s.auto_match).length || 0
      
      // Active matches count
      const { count: totalActiveMatches } = await supabase
        .from('blind_date_matches')
        .select('*', { count: 'exact', head: true })
        .in('status', ['active', 'revealed'])
      
      // Recent matches (last 24 hours)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const { count: recentMatches } = await supabase
        .from('blind_date_matches')
        .select('*', { count: 'exact', head: true })
        .gte('matched_at', yesterday)
      
      // Count users at max matches
      let usersAtMaxMatches = 0
      let eligibleForNewMatches = 0
      
      for (const settings of (enabledSettings || [])) {
        const { count } = await supabase
          .from('blind_date_matches')
          .select('*', { count: 'exact', head: true })
          .or(`user_a.eq.${settings.user_id},user_b.eq.${settings.user_id}`)
          .in('status', ['active', 'revealed'])
        
        const maxMatches = settings.max_active_matches || 3
        if ((count || 0) >= maxMatches) {
          usersAtMaxMatches++
        } else {
          eligibleForNewMatches++
        }
      }
      
      return {
        totalUsers: totalUsers || 0,
        usersWithBlindDatingEnabled,
        usersWithAutoMatch,
        totalActiveMatches: totalActiveMatches || 0,
        usersAtMaxMatches,
        eligibleForNewMatches,
        recentMatches: recentMatches || 0
      }
    } catch (error) {
      logger.error({ error }, 'Error getting diagnostics')
      throw error
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

  /**
   * Admin function to create a blind date match between two specific users
   * Validates:
   * - Both users exist
   * - Users are opposite genders
   * - Users are not already friends
   * - Users don't already have an active blind date match together
   */
  static async adminCreateMatch(userAId: string, userBId: string): Promise<{
    success: boolean;
    match?: BlindDateMatch;
    error?: string;
  }> {
    try {
      // Get both user profiles
      const { data: profiles, error: profilesError } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, gender, age, interests, needs')
        .in('id', [userAId, userBId])
      
      if (profilesError) {
        return { success: false, error: 'Failed to fetch user profiles' }
      }
      
      if (!profiles || profiles.length !== 2) {
        return { success: false, error: 'One or both users not found' }
      }
      
      const userA = profiles.find(p => p.id === userAId)
      const userB = profiles.find(p => p.id === userBId)
      
      if (!userA || !userB) {
        logger.warn({ userAId, userBId, foundProfiles: profiles?.length }, 'Admin match: One or both users not found')
        return { success: false, error: 'One or both users not found' }
      }
      
      logger.info({ 
        userAId, 
        userBId, 
        userAGender: userA.gender, 
        userBGender: userB.gender,
        userAName: userA.first_name,
        userBName: userB.first_name
      }, 'Admin match: Checking gender compatibility')
      
      // Check gender compatibility (must be opposite genders)
      if (!this.isGenderCompatible(userA.gender, userB.gender)) {
        logger.warn({ userAGender: userA.gender, userBGender: userB.gender }, 'Admin match: Gender incompatible')
        return { 
          success: false, 
          error: `Users must be opposite genders. User A: ${userA.gender || 'unknown'}, User B: ${userB.gender || 'unknown'}` 
        }
      }
      
      // Check if they are already friends
      const areFriends = await this.areUsersFriends(userAId, userBId)
      logger.info({ userAId, userBId, areFriends }, 'Admin match: Checked friendship status')
      if (areFriends) {
        return { success: false, error: 'Users are already friends. Cannot create blind date match between friends.' }
      }
      
      // Check if they already have an active blind date match with each other
      const { data: existingMatch } = await supabase
        .from('blind_date_matches')
        .select('id, status')
        .or(`and(user_a.eq.${userAId},user_b.eq.${userBId}),and(user_a.eq.${userBId},user_b.eq.${userAId})`)
        .in('status', ['active', 'revealed'])
        .limit(1)
        .maybeSingle()
      
      if (existingMatch) {
        return { success: false, error: 'These users already have an active blind date match with each other.' }
      }
      
      // Create chat for the users
      let chat
      try {
        chat = await ensureChatForUsers(userAId, userBId)
      } catch (chatError) {
        logger.error({ error: chatError, userAId, userBId }, 'Failed to create/ensure chat for admin match')
        return { success: false, error: 'Failed to create chat between users' }
      }
      
      if (!chat || !chat.id) {
        return { success: false, error: 'Failed to create chat - no chat ID returned' }
      }
      
      // Calculate compatibility score
      const compatibility = CompatibilityService.calculateEnhancedCompatibility(
        { age: userA.age, interests: userA.interests, needs: userA.needs },
        { age: userB.age, interests: userB.interests, needs: userB.needs }
      )
      
      // Create the blind date match
      const [sortedUserA, sortedUserB] = [userAId, userBId].sort()
      
      const { data: match, error: matchError } = await supabase
        .from('blind_date_matches')
        .insert({
          user_a: sortedUserA,
          user_b: sortedUserB,
          chat_id: chat.id,
          compatibility_score: Math.max(compatibility.score, 5), // Minimum score of 5
          status: 'active',
          message_count: 0,
          reveal_threshold: 30,
          user_a_revealed: false,
          user_b_revealed: false,
          matched_at: new Date().toISOString()
        })
        .select('*')
        .single()
      
      if (matchError) {
        logger.error({ error: matchError, userAId, userBId }, 'Failed to create admin blind date match')
        return { success: false, error: 'Failed to create match in database' }
      }
      
      // Notify both users
      const matchData = match as BlindDateMatch
      await this.notifyMatchCreated(userAId, userBId, matchData)
      
      logger.info({ 
        matchId: match.id, 
        userAId, 
        userBId, 
        score: compatibility.score 
      }, '✅ Admin created blind date match')
      
      return { success: true, match: matchData }
    } catch (error) {
      logger.error({ error, userAId, userBId }, 'Error in admin create match')
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }
}

export default BlindDatingService


