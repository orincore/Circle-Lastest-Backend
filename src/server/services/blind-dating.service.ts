import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { blindDateBlockedMessages, blindDateDailyQueue, blindDateMatches, blindDatingSettings, chatMembers, friendships, profiles } from '../db/schema.js'
import { logger } from '../config/logger.js'
import { ensureChatForUsers, getRecentChatTextMessagesForModeration } from '../repos/chat.repo.js'
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

function rowToBlindDateSettingsRow(row: typeof blindDatingSettings.$inferSelect): BlindDateSettings {
  return {
    id: row.id,
    user_id: row.userId,
    is_enabled: row.isEnabled ?? false,
    daily_match_time: row.dailyMatchTime ?? '09:00:00',
    max_active_matches: row.maxActiveMatches ?? 3,
    preferred_reveal_threshold: row.preferredRevealThreshold ?? 30,
    auto_match: row.autoMatch ?? true,
    notifications_enabled: row.notificationsEnabled ?? true,
    last_match_at: row.lastMatchAt ?? undefined,
  }
}

function rowToBlindDateMatchRow(row: typeof blindDateMatches.$inferSelect): BlindDateMatch {
  return {
    id: row.id,
    user_a: row.userA,
    user_b: row.userB,
    chat_id: row.chatId ?? undefined,
    compatibility_score: Number(row.compatibilityScore ?? 0),
    status: row.status as BlindDateMatch['status'],
    message_count: row.messageCount ?? 0,
    reveal_threshold: row.revealThreshold ?? 30,
    user_a_revealed: row.userARevealed ?? false,
    user_b_revealed: row.userBRevealed ?? false,
    revealed_at: row.revealedAt ?? undefined,
    reveal_requested_by: row.revealRequestedBy ?? undefined,
    reveal_requested_at: row.revealRequestedAt ?? undefined,
    matched_at: row.matchedAt ?? '',
    ended_at: row.endedAt ?? undefined,
    ended_by: row.endedBy ?? undefined,
    end_reason: row.endReason ?? undefined,
  }
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
      const [friendship] = await db.select({ id: friendships.id }).from(friendships)
        .where(and(
          or(
            and(eq(friendships.user1Id, userId1), eq(friendships.user2Id, userId2)),
            and(eq(friendships.user1Id, userId2), eq(friendships.user2Id, userId1)),
          ),
          inArray(friendships.status, ['active', 'accepted']),
        ))
        .limit(1)

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
      const [row] = await db.select().from(blindDatingSettings).where(eq(blindDatingSettings.userId, userId)).limit(1)
      return row ? rowToBlindDateSettingsRow(row) : null
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
      const patch: Partial<typeof blindDatingSettings.$inferInsert> = {}
      if (settings.is_enabled !== undefined) patch.isEnabled = settings.is_enabled
      if (settings.daily_match_time !== undefined) patch.dailyMatchTime = settings.daily_match_time
      if (settings.max_active_matches !== undefined) patch.maxActiveMatches = settings.max_active_matches
      if (settings.preferred_reveal_threshold !== undefined) patch.preferredRevealThreshold = settings.preferred_reveal_threshold
      if (settings.auto_match !== undefined) patch.autoMatch = settings.auto_match
      if (settings.notifications_enabled !== undefined) patch.notificationsEnabled = settings.notifications_enabled
      if (settings.last_match_at !== undefined) patch.lastMatchAt = settings.last_match_at

      const [row] = await db.insert(blindDatingSettings)
        .values({ userId, ...patch, updatedAt: new Date().toISOString() })
        .onConflictDoUpdate({
          target: blindDatingSettings.userId,
          set: { ...patch, updatedAt: new Date().toISOString() },
        })
        .returning()

      logger.info({ userId, isEnabled: settings.is_enabled }, 'Blind dating settings updated')
      return rowToBlindDateSettingsRow(row)
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
      const rows = await db.select().from(blindDateMatches)
        .where(and(
          or(eq(blindDateMatches.userA, userId), eq(blindDateMatches.userB, userId)),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))
        .orderBy(desc(blindDateMatches.matchedAt))

      return rows.map(rowToBlindDateMatchRow)
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
      const [row] = await db.select().from(blindDateMatches).where(eq(blindDateMatches.chatId, chatId)).limit(1)

      if (row) {
        return rowToBlindDateMatchRow(row)
      }

      // Fallback for legacy matches where chat_id was not populated
      // 1. Get chat members (we expect 1:1 chats for blind dating)
      const members = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chatId))

      const userIds = members.map(m => m.userId)
      if (userIds.length !== 2) {
        // Not a standard 1:1 chat, treat as no blind date match
        return null
      }

      const [u1, u2] = userIds.sort()

      // 2. Look for an active/revealed blind date match between these two users
      const [fallbackMatch] = await db.select().from(blindDateMatches)
        .where(and(
          or(
            and(eq(blindDateMatches.userA, u1), eq(blindDateMatches.userB, u2)),
            and(eq(blindDateMatches.userA, u2), eq(blindDateMatches.userB, u1)),
          ),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))
        .orderBy(desc(blindDateMatches.matchedAt))
        .limit(1)

      if (!fallbackMatch) {
        return null
      }

      // 3. Best-effort: backfill chat_id on the legacy match so future lookups are fast
      if (!fallbackMatch.chatId) {
        try {
          await db.update(blindDateMatches).set({ chatId }).where(eq(blindDateMatches.id, fallbackMatch.id))
          logger.info({ matchId: fallbackMatch.id, chatId, u1, u2 }, 'Backfilled chat_id on blind date match')
        } catch (updateError) {
          logger.error({ error: updateError, matchId: fallbackMatch.id, chatId }, 'Failed to backfill chat_id on blind date match')
        }
      }

      return rowToBlindDateMatchRow(fallbackMatch)
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
      const [row] = await db.select().from(blindDateMatches).where(eq(blindDateMatches.id, matchId)).limit(1)
      return row ? rowToBlindDateMatchRow(row) : null
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
      const [userProfile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1)

      if (!userProfile) {
        logger.error({ userId }, 'Failed to get user profile')
        return null
      }

      // Get users already in active matches with this user (to exclude)
      const existingMatches = await db.select({ userA: blindDateMatches.userA, userB: blindDateMatches.userB })
        .from(blindDateMatches)
        .where(and(
          or(eq(blindDateMatches.userA, userId), eq(blindDateMatches.userB, userId)),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))

      const excludedUserIds = new Set<string>([userId])
      existingMatches.forEach(m => {
        excludedUserIds.add(m.userA)
        excludedUserIds.add(m.userB)
      })

      logger.info({ userId, excludedCount: excludedUserIds.size - 1 }, 'Finding eligible users for blind dating')

      // Try RPC first, but use robust fallback
      let eligibleUsers: Array<{ user_id: string; compatibility_data: any }> = []

      try {
        const rpcResult: any = await db.execute(sql`select * from find_blind_dating_eligible_users(${userId}::uuid, 100)`)
        if (rpcResult.rows.length > 0) {
          eligibleUsers = rpcResult.rows.map((r: any) => ({ user_id: r.user_id, compatibility_data: r.compatibility_data }))
          logger.info({ userId, count: eligibleUsers.length }, 'Found eligible users via RPC')
        }
      } catch (eligibleError) {
        logger.warn({ error: eligibleError, userId }, 'RPC failed, using fallback query')
      }

      // If RPC returned no results or failed, use fallback
      if (eligibleUsers.length === 0) {
        logger.info({ userId }, 'Using fallback query for eligible users')

        // Get all users with blind dating enabled
        let enabledSettingsRows: Array<{ userId: string; maxActiveMatches: number | null }> = []
        try {
          enabledSettingsRows = await db.select({ userId: blindDatingSettings.userId, maxActiveMatches: blindDatingSettings.maxActiveMatches })
            .from(blindDatingSettings).where(eq(blindDatingSettings.isEnabled, true))
        } catch (settingsError) {
          logger.error({ error: settingsError, userId }, 'Failed to get blind dating settings')
          return null
        }

        const enabledUserIds = enabledSettingsRows
          .map(s => s.userId)
          .filter(id => !excludedUserIds.has(id))

        if (enabledUserIds.length === 0) {
          logger.info({ userId }, 'No other users have blind dating enabled')
          return null
        }

        // Get profiles of enabled users (exclude suspended and deleted)
        let candidateProfiles: Array<{ id: string; age: number | null; gender: string | null; interests: string[] | null; needs: string[] | null; locationCity: string | null; locationCountry: string | null }> = []
        try {
          candidateProfiles = await db.select({
            id: profiles.id, age: profiles.age, gender: profiles.gender, interests: profiles.interests,
            needs: profiles.needs, locationCity: profiles.locationCity, locationCountry: profiles.locationCountry,
          })
            .from(profiles)
            .where(and(inArray(profiles.id, enabledUserIds), isNull(profiles.deletedAt), eq(profiles.isSuspended, false)))
            .limit(100)
        } catch (profilesError) {
          logger.error({ error: profilesError, userId }, 'Failed to get profiles')
          return null
        }

        // Filter out suspended/invisible users, check max matches, and enforce gender compatibility
        const validProfiles: typeof candidateProfiles = []
        const userGender = userProfile.gender?.toLowerCase()

        for (const profile of candidateProfiles) {
          // IMPORTANT: Only match compatible genders (opposite genders only)
          const candidateGender = profile.gender?.toLowerCase()
          if (!this.isGenderCompatible(userGender, candidateGender)) {
            logger.debug({ userId, candidateId: profile.id, userGender, candidateGender }, 'Skipping incompatible gender candidate')
            continue
          }

          // Check if candidate has reached their max active matches
          const candidateSettings = enabledSettingsRows.find(s => s.userId === profile.id)
          const maxMatches = candidateSettings?.maxActiveMatches || 3

          const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
            .where(and(
              or(eq(blindDateMatches.userA, profile.id), eq(blindDateMatches.userB, profile.id)),
              inArray(blindDateMatches.status, ['active', 'revealed']),
            ))

          // Include candidates who haven't reached their max
          if (count < maxMatches) {
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
      const [userProfile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1)

      if (!userProfile) {
        logger.error({ userId }, 'Failed to get user profile')
        return null
      }

      // Get users already in active matches with this user (to exclude)
      const existingMatches = await db.select({ userA: blindDateMatches.userA, userB: blindDateMatches.userB })
        .from(blindDateMatches)
        .where(and(
          or(eq(blindDateMatches.userA, userId), eq(blindDateMatches.userB, userId)),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))

      const excludedUserIds = new Set<string>([userId, ...excludeUserIds])
      existingMatches.forEach(m => {
        excludedUserIds.add(m.userA)
        excludedUserIds.add(m.userB)
      })

      logger.info({ userId, excludedCount: excludedUserIds.size - 1 }, 'Finding eligible users (with exclusions)')

      // Get all users with blind dating enabled
      let enabledSettingsRows: Array<{ userId: string; maxActiveMatches: number | null }> = []
      try {
        enabledSettingsRows = await db.select({ userId: blindDatingSettings.userId, maxActiveMatches: blindDatingSettings.maxActiveMatches })
          .from(blindDatingSettings).where(eq(blindDatingSettings.isEnabled, true))
      } catch (settingsError) {
        logger.error({ error: settingsError, userId }, 'Failed to get blind dating settings')
        return null
      }

      const enabledUserIds = enabledSettingsRows
        .map(s => s.userId)
        .filter(id => !excludedUserIds.has(id))

      if (enabledUserIds.length === 0) {
        logger.info({ userId }, 'No other users available for matching')
        return null
      }

      // Get profiles of enabled users
      let candidateProfiles: Array<{ id: string; age: number | null; gender: string | null; interests: string[] | null; needs: string[] | null; locationCity: string | null; locationCountry: string | null }> = []
      try {
        candidateProfiles = await db.select({
          id: profiles.id, age: profiles.age, gender: profiles.gender, interests: profiles.interests,
          needs: profiles.needs, locationCity: profiles.locationCity, locationCountry: profiles.locationCountry,
        })
          .from(profiles)
          .where(and(inArray(profiles.id, enabledUserIds), isNull(profiles.deletedAt)))
          .limit(100)
      } catch (profilesError) {
        logger.error({ error: profilesError, userId }, 'Failed to get profiles')
        return null
      }

      // Filter for gender compatibility and max matches
      const validProfiles: typeof candidateProfiles = []
      const userGender = userProfile.gender?.toLowerCase()

      for (const profile of candidateProfiles) {
        const candidateGender = profile.gender?.toLowerCase()
        if (!this.isGenderCompatible(userGender, candidateGender)) {
          continue
        }

        // Check if candidate has reached their max active matches
        const candidateSettings = enabledSettingsRows.find(s => s.userId === profile.id)
        const maxMatches = candidateSettings?.maxActiveMatches || 3

        const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
          .where(and(
            or(eq(blindDateMatches.userA, profile.id), eq(blindDateMatches.userB, profile.id)),
            inArray(blindDateMatches.status, ['active', 'revealed']),
          ))

        if (count < maxMatches) {
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

      let matchRow: typeof blindDateMatches.$inferSelect
      try {
        [matchRow] = await db.insert(blindDateMatches).values({
          userA, userB, chatId: chat.id,
          compatibilityScore: String(bestMatch.score),
          status: 'active',
          messageCount: 0,
          revealThreshold: settings.preferred_reveal_threshold,
          userARevealed: false,
          userBRevealed: false,
          matchedAt: new Date().toISOString(),
        }).returning()
      } catch (matchError) {
        logger.error({ error: matchError, userId, matchUserId: bestMatch.userId }, 'Failed to create blind date match')
        throw matchError
      }

      // Update last match time for both users
      await Promise.all([
        db.update(blindDatingSettings).set({ lastMatchAt: new Date().toISOString() }).where(eq(blindDatingSettings.userId, userId)),
        db.update(blindDatingSettings).set({ lastMatchAt: new Date().toISOString() }).where(eq(blindDatingSettings.userId, bestMatch.userId)),
      ])

      logger.info({
        matchId: matchRow.id,
        userId,
        matchUserId: bestMatch.userId,
        score: bestMatch.score
      }, 'Blind date match created')

      // Notify both users
      const matchData = rowToBlindDateMatchRow(matchRow)
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

      // Create in-app notifications. push: false — the dedicated
      // sendBlindDateMatchNotification calls below already deliver the push
      // with the payload the app expects, so the default push here would
      // notify each user twice.
      await NotificationService.createNotification({
        recipient_id: userId,
        type: 'blind_date_match',
        title: '🎭 New Blind Date!',
        message: 'You have a new anonymous match! Start chatting to discover who they are.',
        data: { matchId: match.id, chatId: match.chat_id },
        push: false
      })

      await NotificationService.createNotification({
        recipient_id: otherUserId,
        type: 'blind_date_match',
        title: '🎭 New Blind Date!',
        message: 'You have a new anonymous match! Start chatting to discover who they are.',
        data: { matchId: match.id, chatId: match.chat_id },
        push: false
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
      const emailProfileRows = await db.select({ id: profiles.id, email: profiles.email, firstName: profiles.firstName })
        .from(profiles).where(inArray(profiles.id, [userId, otherUserId]))

      const emailMap = new Map<string, { email: string; first_name: string | null }>()
      emailProfileRows.forEach(p => {
        if (p.email) {
          emailMap.set(p.id, { email: p.email, first_name: p.firstName })
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
      const rows = await db.select({ id: blindDateMatches.id }).from(blindDateMatches)
        .where(and(eq(blindDateMatches.chatId, chatId), inArray(blindDateMatches.status, ['active', 'revealed'])))
        .limit(1)

      return rows.length > 0
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
      const [profile] = await db.select({
        id: profiles.id, firstName: profiles.firstName, lastName: profiles.lastName, username: profiles.username,
        age: profiles.age, gender: profiles.gender, about: profiles.about, interests: profiles.interests,
        needs: profiles.needs, profilePhotoUrl: profiles.profilePhotoUrl, locationCity: profiles.locationCity,
      }).from(profiles).where(eq(profiles.id, userId)).limit(1)

      if (!profile) {
        logger.error({ userId }, 'Failed to get profile for anonymization')
        return null
      }

      if (isRevealed) {
        return {
          id: profile.id,
          first_name: profile.firstName,
          last_name: profile.lastName,
          username: profile.username,
          age: profile.age ?? undefined,
          gender: profile.gender ?? undefined,
          about: profile.about ?? undefined,
          interests: profile.interests ?? undefined,
          needs: profile.needs ?? undefined,
          profile_photo_url: profile.profilePhotoUrl ?? undefined,
          location_city: profile.locationCity ?? undefined,
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

      const anonymizedFirstName = anonymizeName(profile.firstName)
      const anonymizedLastName = anonymizeName(profile.lastName)

      // Generate a consistent anonymous avatar using user ID
      const anonymousAvatar = `https://api.dicebear.com/7.x/shapes/svg?seed=${userId}&backgroundColor=b6e3f4,c0aede,d1d4f9`

      return {
        id: profile.id,
        first_name: anonymizedFirstName,
        last_name: anonymizedLastName,
        username: '***hidden***',
        age: profile.age ?? undefined,
        gender: profile.gender ?? undefined,
        about: undefined, // Hidden in anonymous mode
        interests: profile.interests ?? undefined,
        needs: profile.needs ?? undefined, // This contains the preference (girlfriend, boyfriend, etc.)
        profile_photo_url: profile.profilePhotoUrl ?? undefined, // Show blurry photo
        location_city: profile.locationCity ?? undefined,
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
      const updateData: Partial<typeof blindDateMatches.$inferInsert> = {
        updatedAt: new Date().toISOString()
      }

      if (isUserA) {
        updateData.userARevealed = true
      } else {
        updateData.userBRevealed = true
      }

      // Check if this is the first reveal request
      if (!match.reveal_requested_by) {
        updateData.revealRequestedBy = requestingUserId
        updateData.revealRequestedAt = new Date().toISOString()
      }

      // Check if both will be revealed after this update
      const bothRevealed = (isUserA && match.user_b_revealed) || (isUserB && match.user_a_revealed)

      if (bothRevealed) {
        updateData.status = 'revealed'
        updateData.revealedAt = new Date().toISOString()
      }

      try {
        await db.update(blindDateMatches).set(updateData).where(eq(blindDateMatches.id, matchId))
      } catch (error) {
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
      let existing: { id: string; status: string } | undefined
      try {
        [existing] = await db.select({ id: friendships.id, status: friendships.status }).from(friendships)
          .where(and(eq(friendships.user1Id, smallerId), eq(friendships.user2Id, largerId)))
          .limit(1)
      } catch (checkError) {
        logger.error({ checkError, userA, userB }, '[BlindDate] Error checking existing friendship')
      }

      if (existing) {
        logger.info({ userA, userB, existingStatus: existing.status }, '[BlindDate] Friendship already exists')
        // If it exists but not active/accepted, update it
        if (existing.status !== 'active' && existing.status !== 'accepted') {
          try {
            await db.update(friendships)
              .set({ status: 'accepted', updatedAt: new Date().toISOString() })
              .where(eq(friendships.id, existing.id))
            logger.info({ userA, userB }, '[BlindDate] Updated existing friendship to accepted')
          } catch (updateError) {
            logger.error({ updateError, userA, userB }, '[BlindDate] Error updating friendship status')
            return false
          }
        }
        return true
      }

      // Create new friendship with all required fields
      const now = new Date().toISOString()
      try {
        const [newFriendship] = await db.insert(friendships).values({
          user1Id: smallerId,
          user2Id: largerId,
          senderId: userA, // First user to reveal is considered the "sender"
          status: 'accepted', // Use 'accepted' to match friend request acceptance
          createdAt: now,
          updatedAt: now
        }).returning({ id: friendships.id })

        logger.info({ userA, userB, friendshipId: newFriendship?.id }, '[BlindDate] Successfully created friendship')
        return true
      } catch (insertError: any) {
        // Check if it's a duplicate key error (23505) - that's okay
        if (insertError.code === '23505') {
          logger.info({ userA, userB }, '[BlindDate] Friendship already exists (duplicate key)')
          return true
        }
        logger.error({ insertError, code: insertError?.code, message: insertError?.message }, '[BlindDate] Error inserting friendship')
        return false
      }
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
      let recentMessages: any[] = []
      try {
        if (match.chat_id) {
          recentMessages = await getRecentChatTextMessagesForModeration(match.chat_id, 10)
        }
      } catch (e) {
        logger.warn({ error: e, matchId }, '[BlindDate] Failed to load recent messages for moderation context')
      }

      const analysis = await ContentFilterService.analyzeMessage(message, {
        messageCount: match.message_count,
        // Provide recent conversation so the filter can catch context-based identity reveal
        // e.g. "What is your name?" -> "Akash"
        recentMessages
      })

      if (!analysis.containsPersonalInfo) {
        // AI confirms no personal info - allow
        return { allowed: true, originalMessage: message, analysis }
      }

      // Message contains personal info - block it
      const blockedReason = `Personal information detected: ${analysis.detectedTypes.join(', ')}`
      
      // Store blocked message (fire and forget - don't wait to keep it real-time)
      // This runs in background and doesn't block the response
      db.insert(blindDateBlockedMessages).values({
        blindDateId: matchId,
        senderId,
        originalMessage: message,
        filteredMessage: ContentFilterService.sanitizeMessage(message, analysis),
        blockedReason,
        detectionConfidence: String(analysis.confidence),
        aiAnalysis: analysis as any,
        wasReleased: false,
      })
        .then(() => {
          logger.info({
            matchId,
            senderId,
            detectedTypes: analysis.detectedTypes
          }, 'Message blocked for personal info in blind date')
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

      try {
        await db.update(blindDateMatches).set({
          status: 'ended',
          endedAt: new Date().toISOString(),
          endedBy: userId,
          endReason: reason || 'user_ended',
          updatedAt: new Date().toISOString()
        }).where(eq(blindDateMatches.id, matchId))
      } catch (error) {
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
      const processedToday = await db.select({ userId: blindDateDailyQueue.userId }).from(blindDateDailyQueue)
        .where(and(eq(blindDateDailyQueue.scheduledDate, today), eq(blindDateDailyQueue.status, 'matched')))

      const processedUserIds = new Set(processedToday.map(u => u.userId))

      // Get all users with blind dating enabled
      let allEnabledUsers: Array<{ userId: string }> = []
      try {
        allEnabledUsers = await db.select({ userId: blindDatingSettings.userId }).from(blindDatingSettings)
          .where(and(eq(blindDatingSettings.isEnabled, true), eq(blindDatingSettings.autoMatch, true)))
      } catch (error) {
        logger.error({ error }, 'Failed to get enabled users for daily matching')
        return stats
      }

      // Filter out already processed users
      const enabledUsers = allEnabledUsers.filter(u => !processedUserIds.has(u.userId))

      logger.info({ userCount: enabledUsers.length }, 'Processing daily blind date matches')

      for (const user of enabledUsers) {
        stats.processed++

        try {
          // Create queue entry
          await db.insert(blindDateDailyQueue)
            .values({ userId: user.userId, scheduledDate: today, status: 'pending' })
            .onConflictDoUpdate({
              target: [blindDateDailyQueue.userId, blindDateDailyQueue.scheduledDate],
              set: { status: 'pending' },
            })

          // Try to find a match
          const match = await this.findMatch(user.userId)

          if (match) {
            stats.matched++

            // Update queue entry
            await db.update(blindDateDailyQueue).set({
              status: 'matched',
              matchedUserId: match.user_a === user.userId ? match.user_b : match.user_a,
              matchId: match.id,
              processedAt: new Date().toISOString()
            }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today)))
          } else {
            // No match found
            await db.update(blindDateDailyQueue).set({
              status: 'no_match',
              processedAt: new Date().toISOString()
            }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today)))
          }
        } catch (error) {
          stats.errors++
          logger.error({ error, userId: user.userId }, 'Error processing daily match for user')

          await db.update(blindDateDailyQueue).set({
            status: 'error',
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            processedAt: new Date().toISOString()
          }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today)))
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
      let enabledUsers: Array<{ user_id: string; max_active_matches: number | null }> = []
      try {
        enabledUsers = await db.select({ user_id: blindDatingSettings.userId, max_active_matches: blindDatingSettings.maxActiveMatches })
          .from(blindDatingSettings).where(eq(blindDatingSettings.isEnabled, true))
      } catch (error) {
        logger.error({ error }, 'Failed to get enabled users for force matching')
        return stats
      }

      logger.info({ userCount: enabledUsers.length }, '🚀 Force matching all blind dating users')

      // Track users who got matched in THIS run to ensure 1:1 per run
      const matchedInThisRun = new Set<string>()

      // Process each user
      for (const user of enabledUsers) {
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
      let allUsers: Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; age: number | null; gender: string | null; interests: string[] | null; needs: string[] | null }> = []
      try {
        allUsers = await db.select({
          id: profiles.id, first_name: profiles.firstName, last_name: profiles.lastName, email: profiles.email,
          age: profiles.age, gender: profiles.gender, interests: profiles.interests, needs: profiles.needs,
        }).from(profiles).where(isNull(profiles.deletedAt)).orderBy(desc(profiles.createdAt))
      } catch (usersError) {
        logger.error({ error: usersError }, 'Failed to get users for detailed matching')
        throw usersError
      }

      summary.totalUsers = allUsers.length

      // Get all blind dating settings
      const allSettings = await db.select({
        user_id: blindDatingSettings.userId, is_enabled: blindDatingSettings.isEnabled,
        auto_match: blindDatingSettings.autoMatch, max_active_matches: blindDatingSettings.maxActiveMatches,
      }).from(blindDatingSettings)

      const settingsMap = new Map(allSettings.map(s => [s.user_id, s]))

      // Get all active matches
      const allActiveMatches = await db.select({
        user_a: blindDateMatches.userA, user_b: blindDateMatches.userB, status: blindDateMatches.status,
      }).from(blindDateMatches).where(inArray(blindDateMatches.status, ['active', 'revealed']))

      // Build a map of user -> active match partners
      const activeMatchPartnersMap = new Map<string, Set<string>>()
      for (const match of allActiveMatches) {
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
            { age: user.age ?? undefined, interests: user.interests ?? undefined, needs: user.needs ?? undefined },
            { age: candidate.age ?? undefined, interests: candidate.interests ?? undefined, needs: candidate.needs ?? undefined }
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
      const [{ count: totalUsers }] = await db.select({ count: sql<number>`count(*)::int` }).from(profiles).where(isNull(profiles.deletedAt))

      // Users with blind dating enabled
      const enabledSettings = await db.select({
        user_id: blindDatingSettings.userId, is_enabled: blindDatingSettings.isEnabled,
        auto_match: blindDatingSettings.autoMatch, max_active_matches: blindDatingSettings.maxActiveMatches,
      }).from(blindDatingSettings).where(eq(blindDatingSettings.isEnabled, true))

      const usersWithBlindDatingEnabled = enabledSettings.length
      const usersWithAutoMatch = enabledSettings.filter(s => s.auto_match).length

      // Active matches count
      const [{ count: totalActiveMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
        .where(inArray(blindDateMatches.status, ['active', 'revealed']))

      // Recent matches (last 24 hours)
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const [{ count: recentMatches }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
        .where(gte(blindDateMatches.matchedAt, yesterday))

      // Count users at max matches
      let usersAtMaxMatches = 0
      let eligibleForNewMatches = 0

      for (const settings of enabledSettings) {
        const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(blindDateMatches)
          .where(and(
            or(eq(blindDateMatches.userA, settings.user_id), eq(blindDateMatches.userB, settings.user_id)),
            inArray(blindDateMatches.status, ['active', 'revealed']),
          ))

        const maxMatches = settings.max_active_matches || 3
        if (count >= maxMatches) {
          usersAtMaxMatches++
        } else {
          eligibleForNewMatches++
        }
      }

      return {
        totalUsers,
        usersWithBlindDatingEnabled,
        usersWithAutoMatch,
        totalActiveMatches,
        usersAtMaxMatches,
        eligibleForNewMatches,
        recentMatches
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
      let existingMatch: typeof blindDateMatches.$inferSelect | undefined
      try {
        [existingMatch] = await db.select().from(blindDateMatches)
          .where(and(eq(blindDateMatches.userA, userA), eq(blindDateMatches.userB, userB), inArray(blindDateMatches.status, ['active', 'revealed'])))
          .limit(1)
      } catch (checkError) {
        logger.error({ error: checkError, userId }, 'Error checking for existing test match')
      }

      if (existingMatch) {
        logger.info({ matchId: existingMatch.id, userId, botId: testBotId }, 'Test match already exists')
        return {
          match: rowToBlindDateMatchRow(existingMatch),
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
      let matchRow: typeof blindDateMatches.$inferSelect
      try {
        [matchRow] = await db.insert(blindDateMatches).values({
          userA, userB, chatId: chat.id,
          compatibilityScore: '0.85', // Simulated high compatibility
          status: 'active',
          messageCount: 0,
          revealThreshold,
          userARevealed: false,
          userBRevealed: false,
          matchedAt: new Date().toISOString()
        }).returning()
      } catch (matchError: any) {
        // If it's a unique constraint error, try to get existing match
        if (matchError.code === '23505') {
          logger.info({ userId, testBotId }, 'Match already exists (unique constraint), fetching existing')
          const [existing] = await db.select().from(blindDateMatches)
            .where(and(eq(blindDateMatches.userA, userA), eq(blindDateMatches.userB, userB), inArray(blindDateMatches.status, ['active', 'revealed', 'ended'])))
            .orderBy(desc(blindDateMatches.matchedAt))
            .limit(1)

          if (existing) {
            return {
              match: rowToBlindDateMatchRow(existing),
              botUserId: testBotId
            }
          }
        }

        logger.error({
          error: matchError,
          errorCode: matchError?.code,
          errorMessage: matchError?.message,
          userId
        }, 'Failed to create test match')
        throw matchError
      }

      logger.info({ matchId: matchRow.id, userId, botId: testBotId }, 'Test blind date match created')

      return {
        match: rowToBlindDateMatchRow(matchRow),
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
      let existingBot: { id: string; username: string | null } | undefined
      try {
        [existingBot] = await db.select({ id: profiles.id, username: profiles.username }).from(profiles)
          .where(eq(profiles.email, testBotEmail)).limit(1)
      } catch (checkError) {
        logger.error({ error: checkError }, 'Error checking for existing test bot')
      }

      if (existingBot) {
        logger.info({ botId: existingBot.id }, 'Test bot already exists')

        // Ensure blind dating is enabled for bot
        try {
          await db.insert(blindDatingSettings).values({
            userId: existingBot.id, isEnabled: true, maxActiveMatches: 100, preferredRevealThreshold: 30,
          }).onConflictDoUpdate({
            target: blindDatingSettings.userId,
            set: { isEnabled: true, maxActiveMatches: 100, preferredRevealThreshold: 30 },
          })
        } catch (settingsError) {
          logger.error({ error: settingsError, botId: existingBot.id }, 'Failed to enable blind dating for bot')
        }

        return existingBot.id
      }

      // Check if username is taken (try variations)
      let username = testBotUsername
      let usernameTaken = true
      let attempts = 0

      while (usernameTaken && attempts < 5) {
        const [usernameCheck] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.username, username)).limit(1)

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

      let createdBot: { id: string } | undefined
      try {
        [createdBot] = await db.insert(profiles).values({
          id: botId,
          email: testBotEmail,
          username,
          firstName: 'Mystery',
          lastName: 'Match',
          passwordHash, // Required field - dummy hash since bot never logs in
          emailVerified: true, // Set to true so bot can function normally
          gender: Math.random() > 0.5 ? 'female' : 'male',
          age: Math.floor(Math.random() * 10) + 22, // 22-32
          about: 'Hi! I am an AI test partner for blind dating. Chat with me to test the feature!',
          interests: ['Music', 'Travel', 'Movies', 'Food', 'Technology'],
          needs: ['Friendship', 'Dating', 'Conversation'],
          locationCity: 'Mumbai',
          locationCountry: 'India',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }).returning({ id: profiles.id })
      } catch (createError: any) {
        logger.error({ error: createError }, 'Failed to create test bot profile')

        // If it's a unique constraint error, try to find existing bot by username
        if (createError.code === '23505') {
          const [existingByUsername] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.username, username)).limit(1)

          if (existingByUsername) {
            logger.info({ botId: existingByUsername.id }, 'Found existing bot by username')
            return existingByUsername.id
          }
        }

        throw createError
      }

      // Enable blind dating for bot
      try {
        await db.insert(blindDatingSettings).values({
          userId: createdBot.id, isEnabled: true, maxActiveMatches: 100, preferredRevealThreshold: 30,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        })
      } catch (settingsError) {
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
      let profileRows: Array<{ id: string; first_name: string | null; last_name: string | null; gender: string | null; age: number | null; interests: string[] | null; needs: string[] | null }> = []
      try {
        profileRows = await db.select({
          id: profiles.id, first_name: profiles.firstName, last_name: profiles.lastName,
          gender: profiles.gender, age: profiles.age, interests: profiles.interests, needs: profiles.needs,
        }).from(profiles).where(inArray(profiles.id, [userAId, userBId]))
      } catch (profilesError) {
        return { success: false, error: 'Failed to fetch user profiles' }
      }

      if (profileRows.length !== 2) {
        return { success: false, error: 'One or both users not found' }
      }

      const userA = profileRows.find(p => p.id === userAId)
      const userB = profileRows.find(p => p.id === userBId)

      if (!userA || !userB) {
        logger.warn({ userAId, userBId, foundProfiles: profileRows.length }, 'Admin match: One or both users not found')
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
      if (!this.isGenderCompatible(userA.gender ?? undefined, userB.gender ?? undefined)) {
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
      const [existingMatch] = await db.select({ id: blindDateMatches.id, status: blindDateMatches.status }).from(blindDateMatches)
        .where(and(
          or(
            and(eq(blindDateMatches.userA, userAId), eq(blindDateMatches.userB, userBId)),
            and(eq(blindDateMatches.userA, userBId), eq(blindDateMatches.userB, userAId)),
          ),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))
        .limit(1)

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
        { age: userA.age ?? undefined, interests: userA.interests ?? undefined, needs: userA.needs ?? undefined },
        { age: userB.age ?? undefined, interests: userB.interests ?? undefined, needs: userB.needs ?? undefined }
      )

      // Create the blind date match
      const [sortedUserA, sortedUserB] = [userAId, userBId].sort()

      let matchRow: typeof blindDateMatches.$inferSelect
      try {
        [matchRow] = await db.insert(blindDateMatches).values({
          userA: sortedUserA,
          userB: sortedUserB,
          chatId: chat.id,
          compatibilityScore: String(Math.max(compatibility.score, 5)), // Minimum score of 5
          status: 'active',
          messageCount: 0,
          revealThreshold: 30,
          userARevealed: false,
          userBRevealed: false,
          matchedAt: new Date().toISOString()
        }).returning()
      } catch (matchError) {
        logger.error({ error: matchError, userAId, userBId }, 'Failed to create admin blind date match')
        return { success: false, error: 'Failed to create match in database' }
      }

      // Notify both users
      const matchData = rowToBlindDateMatchRow(matchRow)
      await this.notifyMatchCreated(userAId, userBId, matchData)

      logger.info({
        matchId: matchRow.id,
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


