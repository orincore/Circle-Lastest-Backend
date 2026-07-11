import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { blindDateBlockedMessages, blindDateDailyQueue, blindDateMatches, blindDatingSettings, chatMembers, friendships, profiles } from '../db/schema.js'
import { logger } from '../config/logger.js'
import { cache } from './cache.js'
import { ensureChatForUsers, getRecentChatTextMessagesForModeration } from '../repos/chat.repo.js'
import { CompatibilityService } from './compatibility.service.js'
import { ContentFilterService, type PersonalInfoAnalysis } from './ai/content-filter.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { NotificationService } from './notificationService.js'
import { PushNotificationService } from './pushNotificationService.js'
import { EMAIL_SENDERS } from '../config/emailSenders.js'
import { randomUUID } from 'crypto'
import { hashPassword } from '../utils/password.js'
import { Redis } from 'ioredis'

// Dedicated lock connection, same lightweight self-contained pattern as
// workers/matchmaking-worker.ts's distributed lock -- lazyConnect so this
// never opens a connection just from being imported.
const lockRedis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 2,
  lazyConnect: true,
})
lockRedis.on('error', (err) => {
  logger.error({ err }, 'Blind dating lock Redis client error')
})
const MATCHING_LOCK_KEY = 'blind_dating:matching_lock'
const MATCHING_LOCK_TTL_SECONDS = 120
const LOCK_OWNER_ID = `blind-dating-${process.pid}-${Date.now()}`

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

// 'strict'    -- best-quality daily attempt: requires a real compatibility
//                score and respects the re-match cooldown.
// 'relaxed'   -- same candidate pool, drops the score requirement.
// 'guarantee' -- last resort for a user about to go a full week without a
//                match: ignores score AND the cooldown.
export type MatchTier = 'strict' | 'relaxed' | 'guarantee'

interface MatchingPassStats {
  processed: number
  matched: number
  errors: number
  expired: number
  guaranteed: number
  details: Array<{ userId: string; status: string; matchId?: string; error?: string }>
}

interface CandidateProfileRow {
  id: string
  age: number | null
  gender: string | null
  interests: string[] | null
  needs: string[] | null
  locationCity: string | null
  locationCountry: string | null
  agePreference: string | null
  locationPreference: string | null
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

// Raw Postgres timestamptz text (Drizzle `mode: 'string'`, e.g.
// "2026-07-05 10:30:00.123456+00") parses leniently under Node's V8 (and
// therefore in a browser client hitting this API), but React Native's
// Hermes engine rejects it and silently produces an Invalid Date -- which
// made `matched_at` comparisons like "was this match made today?" always
// false on iOS/Android while working fine on web. Normalize to ISO 8601 so
// every client can parse it.
function toIsoOrUndefined(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
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
    revealed_at: toIsoOrUndefined(row.revealedAt),
    reveal_requested_by: row.revealRequestedBy ?? undefined,
    reveal_requested_at: toIsoOrUndefined(row.revealRequestedAt),
    matched_at: toIsoOrUndefined(row.matchedAt) ?? '',
    ended_at: toIsoOrUndefined(row.endedAt),
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

  // ===========================================================================
  // Matching engine (tiered relaxation + weekly guarantee)
  // ===========================================================================
  //
  // maxActiveMatches is intentionally never enforced anywhere below. With 68
  // enabled users (47 male / 19 female) and a hard opposite-gender rule, the
  // old 3-match cap left half the enabled population permanently stuck at
  // "3/3" with zero path to a new match regardless of algorithm quality -- a
  // live production run against all 68 enabled users produced zero new
  // matches. Real engagement is self-limiting anyway (nobody keeps ten
  // conversations going), and expireStaleMatches() now means abandoned
  // matches no longer accumulate forever, so the cap was doing more harm
  // (blocking rotation) than good (prevented nothing real).

  private static readonly RECENT_PARTNER_COOLDOWN_DAYS = 21

  /** Batched replacement for the old one-friendship-check-per-candidate loop. */
  private static async getFriendIdSet(userId: string, candidateIds: string[]): Promise<Set<string>> {
    if (candidateIds.length === 0) return new Set()
    try {
      const rows = await db.select({ user1: friendships.user1Id, user2: friendships.user2Id })
        .from(friendships)
        .where(and(
          inArray(friendships.status, ['active', 'accepted']),
          or(
            and(eq(friendships.user1Id, userId), inArray(friendships.user2Id, candidateIds)),
            and(eq(friendships.user2Id, userId), inArray(friendships.user1Id, candidateIds)),
          ),
        ))
      const set = new Set<string>()
      for (const r of rows) set.add(r.user1 === userId ? r.user2 : r.user1)
      return set
    } catch (error) {
      logger.error({ error, userId }, 'Error batch-checking friendships')
      return new Set()
    }
  }

  /**
   * Anyone this user has an ENDED or EXPIRED match with, and how recently --
   * used to softly de-prioritize (not permanently block) re-pairing the same
   * two people over and over in a small pool.
   */
  private static async getRecentPartnerMap(userId: string): Promise<Map<string, number>> {
    try {
      const rows = await db.select({
        userA: blindDateMatches.userA,
        userB: blindDateMatches.userB,
        endedAt: blindDateMatches.endedAt,
        matchedAt: blindDateMatches.matchedAt,
      })
        .from(blindDateMatches)
        .where(and(
          or(eq(blindDateMatches.userA, userId), eq(blindDateMatches.userB, userId)),
          inArray(blindDateMatches.status, ['ended', 'expired']),
        ))

      const map = new Map<string, number>()
      for (const row of rows) {
        const partnerId = row.userA === userId ? row.userB : row.userA
        const when = new Date(row.endedAt || row.matchedAt || 0).getTime()
        const existing = map.get(partnerId)
        if (!existing || when > existing) map.set(partnerId, when)
      }
      return map
    } catch (error) {
      logger.error({ error, userId }, 'Error loading recent partner history')
      return new Map()
    }
  }

  /**
   * Age-preference- and location-preference-aware compatibility score.
   * Wraps CompatibilityService.calculateEnhancedCompatibility (interests /
   * needs / age / neutral-location) and folds in two profile fields that
   * already existed but blind dating never read: agePreference
   * (close/similar/flexible/open/any -- same scale explore.routes.ts /
   * matchmaking-optimized.ts already use) and locationPreference
   * (nearby/international). Both are soft nudges, never hard filters, so
   * they can't shrink an already-small pool.
   */
  private static readonly AGE_PREFERENCE_RANGE: Record<string, number | null> = {
    close: 2, similar: 5, flexible: 10, open: 15, any: null,
  }

  private static scoreCandidate(
    userProfile: { age?: number | null; interests?: string[] | null; needs?: string[] | null; agePreference?: string | null; locationPreference?: string | null; locationCity?: string | null; locationCountry?: string | null },
    candidate: { age?: number | null; interests?: string[] | null; needs?: string[] | null; locationCity?: string | null; locationCountry?: string | null },
  ): number {
    const base = CompatibilityService.calculateEnhancedCompatibility(
      { age: userProfile.age ?? undefined, interests: userProfile.interests ?? undefined, needs: userProfile.needs ?? undefined },
      { age: candidate.age ?? undefined, interests: candidate.interests ?? undefined, needs: candidate.needs ?? undefined },
    )

    let score = base.score

    if (userProfile.age != null && candidate.age != null) {
      const range = this.AGE_PREFERENCE_RANGE[userProfile.agePreference || 'flexible']
      if (range != null) {
        const diff = Math.abs(userProfile.age - candidate.age)
        score += diff <= range ? 3 : -3
      }
    }

    if (userProfile.locationCity && candidate.locationCity && userProfile.locationCity === candidate.locationCity) {
      score += 4
    } else if (userProfile.locationCountry && candidate.locationCountry && userProfile.locationCountry === candidate.locationCountry) {
      score += 2
    } else if ((userProfile.locationPreference || 'nearby') === 'nearby' && userProfile.locationCountry && candidate.locationCountry && userProfile.locationCountry !== candidate.locationCountry) {
      score -= 2
    }

    return Math.round(score * 10) / 10
  }

  /**
   * Gathers every gender-compatible, non-friend, not-currently-matched
   * candidate for a user -- the shared pool all three tiers score against.
   */
  private static async getCandidatePool(
    userId: string,
    userProfile: { gender?: string | null },
    excludeUserIds: Set<string>,
  ): Promise<CandidateProfileRow[]> {
    const enabledSettingsRows = await db.select({ userId: blindDatingSettings.userId })
      .from(blindDatingSettings).where(eq(blindDatingSettings.isEnabled, true))

    const candidateIds = enabledSettingsRows.map(s => s.userId).filter(id => !excludeUserIds.has(id))
    if (candidateIds.length === 0) return []

    const candidateProfiles = await db.select({
      id: profiles.id, age: profiles.age, gender: profiles.gender, interests: profiles.interests,
      needs: profiles.needs, locationCity: profiles.locationCity, locationCountry: profiles.locationCountry,
      agePreference: profiles.agePreference, locationPreference: profiles.locationPreference,
    })
      .from(profiles)
      .where(and(
        inArray(profiles.id, candidateIds),
        isNull(profiles.deletedAt),
        eq(profiles.isSuspended, false),
        eq(profiles.invisibleMode, false),
      ))
      .limit(200)

    const userGender = userProfile.gender?.toLowerCase()
    const genderFiltered = candidateProfiles.filter(p => this.isGenderCompatible(userGender, p.gender?.toLowerCase()))
    if (genderFiltered.length === 0) return []

    const friendIds = await this.getFriendIdSet(userId, genderFiltered.map(p => p.id))
    return genderFiltered.filter(p => !friendIds.has(p.id))
  }

  /**
   * Single entry point for creating a match at a given relaxation tier.
   * Tries only this tier -- callers (findMatch / the weekly guarantee
   * sweep) decide whether to retry at a looser tier when this returns null.
   */
  static async attemptMatch(
    userId: string,
    tier: MatchTier = 'strict',
    excludeUserIds: Set<string> = new Set(),
  ): Promise<BlindDateMatch | null> {
    try {
      const settings = await this.getSettings(userId)
      if (!settings?.is_enabled) return null

      const [userProfile] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1)
      if (!userProfile) {
        logger.error({ userId }, 'Failed to get user profile')
        return null
      }

      // Currently-active/revealed partners are off-limits at every tier --
      // you can't "guarantee-match" someone you're already matched with.
      const existingMatches = await db.select({ userA: blindDateMatches.userA, userB: blindDateMatches.userB })
        .from(blindDateMatches)
        .where(and(
          or(eq(blindDateMatches.userA, userId), eq(blindDateMatches.userB, userId)),
          inArray(blindDateMatches.status, ['active', 'revealed']),
        ))

      const fullyExcluded = new Set<string>([userId, ...excludeUserIds])
      existingMatches.forEach(m => { fullyExcluded.add(m.userA); fullyExcluded.add(m.userB) })

      const pool = await this.getCandidatePool(userId, userProfile, fullyExcluded)
      if (pool.length === 0) {
        logger.info({ userId, tier }, 'No eligible candidates in pool')
        return null
      }

      const recentPartners = tier === 'guarantee' ? new Map<string, number>() : await this.getRecentPartnerMap(userId)
      const cooldownCutoff = Date.now() - this.RECENT_PARTNER_COOLDOWN_DAYS * 24 * 60 * 60 * 1000

      const scored = pool.map(candidate => {
        const rawScore = this.scoreCandidate(userProfile, candidate)
        const lastPartneredAt = recentPartners.get(candidate.id)
        const onCooldown = lastPartneredAt != null && lastPartneredAt > cooldownCutoff
        return { candidate, rawScore, onCooldown }
      })

      const MIN_SCORE: Record<MatchTier, number> = { strict: 12, relaxed: -Infinity, guarantee: -Infinity }

      // Prefer candidates not on cooldown; only reach for one on cooldown if
      // that's genuinely all that's left, and only at the guarantee tier --
      // a repeat match beats no match at all in a small pool.
      const notOnCooldown = scored.filter(s => !s.onCooldown && s.rawScore >= MIN_SCORE[tier])
      const pickFrom = notOnCooldown.length > 0 ? notOnCooldown : (tier === 'guarantee' ? scored : [])

      if (pickFrom.length === 0) return null

      pickFrom.sort((a, b) => b.rawScore - a.rawScore)
      const best = pickFrom[0]

      return this.createMatchRecord(userId, best.candidate.id, Math.max(best.rawScore, 5), settings)
    } catch (error) {
      logger.error({ error, userId, tier }, 'Error attempting blind date match')
      return null
    }
  }

  /**
   * Finalizes a chosen pairing: creates the chat, the match row, updates
   * lastMatchAt for both, and sends notifications.
   */
  private static async createMatchRecord(
    userId: string,
    matchUserId: string,
    score: number,
    settings: BlindDateSettings,
  ): Promise<BlindDateMatch | null> {
    try {
      const [userA, userB] = [userId, matchUserId].sort()
      const chat = await ensureChatForUsers(userId, matchUserId)

      let matchRow: typeof blindDateMatches.$inferSelect
      try {
        [matchRow] = await db.insert(blindDateMatches).values({
          userA, userB, chatId: chat.id,
          compatibilityScore: String(score),
          status: 'active',
          messageCount: 0,
          revealThreshold: settings.preferred_reveal_threshold,
          userARevealed: false,
          userBRevealed: false,
          matchedAt: new Date().toISOString(),
        }).returning()
      } catch (matchError) {
        // Unique constraint (userA, userB, status) -- another concurrent run
        // already paired these same two people. Not a real failure, just a
        // lost race for this specific pair.
        logger.warn({ error: matchError, userId, matchUserId }, 'Failed to create match record (likely already matched)')
        return null
      }

      await Promise.all([
        db.update(blindDatingSettings).set({ lastMatchAt: new Date().toISOString() }).where(eq(blindDatingSettings.userId, userId)),
        db.update(blindDatingSettings).set({ lastMatchAt: new Date().toISOString() }).where(eq(blindDatingSettings.userId, matchUserId)),
      ])

      logger.info({ matchId: matchRow.id, userId, matchUserId, score }, 'Blind date match created')

      const matchData = rowToBlindDateMatchRow(matchRow)
      await this.notifyMatchCreated(userId, matchUserId, matchData)
      return matchData
    } catch (error) {
      logger.error({ error, userId, matchUserId }, 'Error creating match record')
      return null
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
   * Find and create a new blind date match for a user (on-demand, e.g. a
   * user-triggered "find me a match" action). Tries strict quality first,
   * falls back to relaxed if nothing qualifies -- never uses the guarantee
   * tier, which is reserved for the weekly scheduler sweep (see
   * runWeeklyGuaranteeSweep).
   */
  static async findMatch(userId: string): Promise<BlindDateMatch | null> {
    return (await this.attemptMatch(userId, 'strict')) ?? (await this.attemptMatch(userId, 'relaxed'))
  }

  /**
   * Same as findMatch, but excludes a caller-supplied set of user IDs --
   * used by batch runs so nobody gets paired with someone already matched
   * earlier in the same run.
   */
  static async findMatchExcluding(userId: string, excludeUserIds: Set<string>): Promise<BlindDateMatch | null> {
    return (await this.attemptMatch(userId, 'strict', excludeUserIds)) ?? (await this.attemptMatch(userId, 'relaxed', excludeUserIds))
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

      // Send anonymized email notifications to both users if emails are available.
      // This must be the generic emailService (src/services/emailService.ts),
      // which exposes sendEmail() -- the main EmailService class at
      // ./emailService.js only exposes specific named template methods and
      // has no sendEmail(), so this previously resolved to a nonexistent
      // method and silently failed inside the catch block below.
      const { default: EmailService }: any = await import('../../services/emailService.js')
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
          from: EMAIL_SENDERS.noreply,
          to: userEmailInfo.email,
          subject: 'New blind date match on Circle',
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
          from: EMAIL_SENDERS.noreply,
          to: otherEmailInfo.email,
          subject: 'New blind date match on Circle',
          html,
        })
      }
    } catch (error) {
      logger.error({ error, userId, otherUserId }, 'Failed to notify users about blind date match')
    }
  }

  /**
   * Check if a chat is a blind date chat. This used to be a plain uncached
   * query, but it's called twice per message send (once to gate masking,
   * once again in optimized-socket.ts's post-insert notification block) --
   * on the hot path of every single message in the app, not just blind-date
   * ones. A match's chat only transitions in/out of ['active','revealed']
   * at a handful of well-defined points (match creation, reveal, end/expire)
   * across a large surface of call sites in this file, so rather than
   * chase every status-write site for exact invalidation (real risk of
   * missing one and permanently caching a stale answer), this uses a short
   * TTL as the correctness backstop -- same "cache is best-effort, TTL is
   * the safety net" posture as cache.ts's own header comment, capping any
   * staleness to well under the window a user would notice.
   */
  static async isBlindDateChat(chatId: string): Promise<boolean> {
    const cacheKey = `chattype:blinddate:${chatId}`
    const cached = await cache.getJSON<boolean>(cacheKey)
    if (cached !== null) return cached

    try {
      const rows = await db.select({ id: blindDateMatches.id }).from(blindDateMatches)
        .where(and(eq(blindDateMatches.chatId, chatId), inArray(blindDateMatches.status, ['active', 'revealed'])))
        .limit(1)

      const isBlindDate = rows.length > 0
      await cache.setJSON(cacheKey, isBlindDate, 60)
      return isBlindDate
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

        // getAnonymizedProfile can return null (e.g. the profile row was
        // deleted between match creation and reveal) -- fall back to a
        // generic label rather than letting a missing profile break the
        // notification text or the (string-typed) push helper below.
        const user2Name = profile2?.first_name || 'Your match'
        const user1Name = profile1?.first_name || 'Your match'

        // Create in-app notifications. push: false -- the dedicated
        // sendBlindDateRevealNotification calls below already deliver the
        // push with the payload the app expects (same pattern as the
        // blind_date_match notifications above), so the default push here
        // would notify each user twice.
        await Promise.all([
          NotificationService.createNotification({
            recipient_id: match.user_a,
            type: 'blind_date_reveal',
            title: '🎉 Identity Revealed!',
            message: `${user2Name} has revealed their identity to you!`,
            data: { matchId, chatId: match.chat_id },
            push: false
          }),
          NotificationService.createNotification({
            recipient_id: match.user_b,
            type: 'blind_date_reveal',
            title: '🎉 Identity Revealed!',
            message: `${user1Name} has revealed their identity to you!`,
            data: { matchId, chatId: match.chat_id },
            push: false
          })
        ])

        // Send push notifications to both users -- this is what makes a
        // backgrounded/killed app learn about the reveal and lets tapping
        // the notification open the chat (see AndroidNotificationService's
        // 'blind_date_reveal' case on the mobile side).
        await Promise.all([
          PushNotificationService.sendBlindDateRevealNotification(
            match.user_a,
            user2Name,
            matchId,
            match.chat_id || ''
          ),
          PushNotificationService.sendBlindDateRevealNotification(
            match.user_b,
            user1Name,
            matchId,
            match.chat_id || ''
          )
        ])

        logger.info({ matchId, userA: match.user_a, userB: match.user_b }, 'Sent blind date reveal push notifications')
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
   * Auto-expire matches nobody ever used, freeing their maxActiveMatches
   * slot back up for real matching.
   *
   * This is the single highest-impact fix for "running out of blind
   * connects": production data showed 91 of 96 'active' matches had
   * exchanged zero messages (some since December), permanently occupying
   * slots and leaving ~half of enabled users pinned at their 3-match cap
   * with nothing anyone could do about it -- a live matching run against
   * all 68 enabled users produced zero new matches. A match that's sat
   * untouched for a full week is clearly abandoned; recycling it is what
   * lets a fresh, better-fitting match take its place. The existing 24h
   * inactivity reminder already gives people a nudge before this kicks in,
   * so nobody loses a match without warning.
   *
   * Should run at the start of every matching cycle, before eligibility is
   * computed, so freed slots are usable in the same run.
   */
  static readonly STALE_MATCH_DAYS = 7

  static async expireStaleMatches(): Promise<{ expired: number }> {
    try {
      const cutoff = new Date(Date.now() - this.STALE_MATCH_DAYS * 24 * 60 * 60 * 1000).toISOString()

      const expiredRows = await db.update(blindDateMatches)
        .set({
          status: 'expired',
          endedAt: new Date().toISOString(),
          endReason: 'auto_expired_inactive',
          updatedAt: new Date().toISOString(),
        })
        .where(and(
          eq(blindDateMatches.status, 'active'),
          eq(blindDateMatches.messageCount, 0),
          sql`${blindDateMatches.matchedAt} < ${cutoff}`,
        ))
        .returning({ id: blindDateMatches.id, userA: blindDateMatches.userA, userB: blindDateMatches.userB, chatId: blindDateMatches.chatId })

      if (expiredRows.length === 0) {
        return { expired: 0 }
      }

      logger.info({ count: expiredRows.length }, '⏳ Auto-expired stale zero-message blind date matches')

      // Best-effort, low-key notification -- not a failure state, just lets
      // them know a fresh match is coming rather than the old one silently
      // vanishing. Never let a notification failure block the expiry itself.
      for (const row of expiredRows) {
        for (const userId of [row.userA, row.userB]) {
          try {
            emitToUser(userId, 'blind_date:expired', {
              matchId: row.id,
              chatId: row.chatId,
              message: 'Your blind date match went quiet, so we freed it up for a fresh one.',
            })
          } catch (notifyError) {
            logger.error({ error: notifyError, matchId: row.id, userId }, 'Failed to notify user of auto-expired match')
          }
        }
      }

      return { expired: expiredRows.length }
    } catch (error) {
      logger.error({ error }, 'Error expiring stale blind date matches')
      return { expired: 0 }
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

  private static readonly WEEKLY_GUARANTEE_DAYS = 7

  /**
   * One full matching pass across all enabled+autoMatch users: expires
   * stale matches first (freeing slots), then attempts strict -> relaxed
   * for everyone, ordered so whoever has gone longest without a match is
   * tried first (fairest use of a small, gender-imbalanced pool -- 47 male
   * / 19 female in production means first-come-first-served order would
   * let whoever's processed early hog every fresh match). Anyone still
   * unmatched afterward who is within a day of the weekly guarantee
   * deadline gets one more attempt at the guarantee tier, which ignores
   * score and cooldown -- a repeat match beats no match in a small pool.
   *
   * Shared by processDailyMatches (the scheduled cron) and
   * forceMatchAllUsers (admin on-demand trigger) -- both want the exact
   * same engine, just invoked on different schedules.
   */

  /**
   * Redis-locked entry point. Two things can trigger a matching pass --
   * the daily cron (blind-dating-scheduler.ts) and admin on-demand routes
   * calling forceMatchAllUsers -- and a production run already showed real
   * damage from unlocked concurrent runs: two users ended up with 4 active
   * matches against their own 3-match cap because two overlapping runs both
   * read "under the cap" before either had committed its insert. The cap
   * itself is gone now, but the same race would still let the same pair of
   * users get matched TWICE in one pass. If the lock can't be acquired,
   * something else is already running -- skip this invocation entirely
   * rather than block waiting, so an admin-triggered run never hangs behind
   * the nightly cron.
   */
  static async runMatchingPass(): Promise<MatchingPassStats> {
    const emptyStats: MatchingPassStats = { processed: 0, matched: 0, errors: 0, expired: 0, guaranteed: 0, details: [] }

    let lockAcquired = false
    try {
      const result = await lockRedis.set(MATCHING_LOCK_KEY, LOCK_OWNER_ID, 'EX', MATCHING_LOCK_TTL_SECONDS, 'NX')
      lockAcquired = result === 'OK'
    } catch (error) {
      // Redis unreachable -- fail OPEN rather than silently never matching
      // anyone again. The N+1-free batched queries and the unique
      // (userA,userB,status) DB constraint still make a genuine double-match
      // very unlikely even without the lock; missing a lock is far less
      // harmful than blind dating quietly stopping altogether.
      logger.error({ error }, 'Failed to acquire blind dating matching lock -- proceeding without it')
      lockAcquired = true
    }

    if (!lockAcquired) {
      logger.info('Blind dating matching pass already running elsewhere -- skipping this invocation')
      return emptyStats
    }

    try {
      return await this.runMatchingPassUnlocked()
    } finally {
      try {
        const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
        await lockRedis.eval(script, 1, MATCHING_LOCK_KEY, LOCK_OWNER_ID)
      } catch (error) {
        logger.error({ error }, 'Failed to release blind dating matching lock')
      }
    }
  }

  private static async runMatchingPassUnlocked(): Promise<MatchingPassStats> {
    const stats: MatchingPassStats = { processed: 0, matched: 0, errors: 0, expired: 0, guaranteed: 0, details: [] }
    const today = new Date().toISOString().split('T')[0]

    try {
      const { expired } = await this.expireStaleMatches()
      stats.expired = expired

      // Skip anyone a same-day run already matched -- extra defense-in-depth
      // on top of the lock above, so a duplicate match on the same day can't
      // happen even if the lock is ever bypassed (Redis down) or its TTL is
      // exceeded by an unusually slow run.
      const processedToday = await db.select({ userId: blindDateDailyQueue.userId }).from(blindDateDailyQueue)
        .where(and(eq(blindDateDailyQueue.scheduledDate, today), eq(blindDateDailyQueue.status, 'matched')))
      const processedUserIds = new Set(processedToday.map(u => u.userId))

      const enabledRows = await db.select({ userId: blindDatingSettings.userId, lastMatchAt: blindDatingSettings.lastMatchAt })
        .from(blindDatingSettings)
        .where(and(eq(blindDatingSettings.isEnabled, true), eq(blindDatingSettings.autoMatch, true)))

      const candidates = enabledRows.filter(u => !processedUserIds.has(u.userId))

      // Longest-overdue first: never-matched users (null lastMatchAt) sort
      // before anyone with a timestamp.
      const ordered = [...candidates].sort((a, b) => {
        const aTime = a.lastMatchAt ? new Date(a.lastMatchAt).getTime() : 0
        const bTime = b.lastMatchAt ? new Date(b.lastMatchAt).getTime() : 0
        return aTime - bTime
      })

      logger.info({ userCount: ordered.length }, 'Processing blind date matching pass')

      const matchedInThisRun = new Set<string>()
      const stillUnmatched: Array<{ userId: string; lastMatchAt: string | null }> = []

      for (const user of ordered) {
        stats.processed++

        if (matchedInThisRun.has(user.userId)) {
          stats.details.push({ userId: user.userId, status: 'skipped', error: 'Already matched with someone in this run' })
          continue
        }

        try {
          await db.insert(blindDateDailyQueue)
            .values({ userId: user.userId, scheduledDate: today, status: 'pending' })
            .onConflictDoUpdate({
              target: [blindDateDailyQueue.userId, blindDateDailyQueue.scheduledDate],
              set: { status: 'pending' },
            })

          const match = await this.findMatchExcluding(user.userId, matchedInThisRun)

          if (match) {
            stats.matched++
            const partnerId = match.user_a === user.userId ? match.user_b : match.user_a
            matchedInThisRun.add(user.userId)
            matchedInThisRun.add(partnerId)
            stats.details.push({ userId: user.userId, status: 'matched', matchId: match.id })

            await db.update(blindDateDailyQueue).set({
              status: 'matched',
              matchedUserId: partnerId,
              matchId: match.id,
              processedAt: new Date().toISOString(),
            }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today)))
          } else {
            stillUnmatched.push(user)
            stats.details.push({ userId: user.userId, status: 'no_match', error: 'No eligible candidates found' })

            await db.update(blindDateDailyQueue).set({
              status: 'no_match',
              processedAt: new Date().toISOString(),
            }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today)))
          }
        } catch (error) {
          stats.errors++
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          stats.details.push({ userId: user.userId, status: 'error', error: errorMsg })
          logger.error({ error, userId: user.userId }, 'Error in matching pass')

          await db.update(blindDateDailyQueue).set({
            status: 'error',
            errorMessage: errorMsg,
            processedAt: new Date().toISOString(),
          }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today))).catch(() => {})
        }
      }

      // Weekly guarantee sweep.
      const guaranteeCutoff = Date.now() - (this.WEEKLY_GUARANTEE_DAYS - 1) * 24 * 60 * 60 * 1000
      for (const user of stillUnmatched) {
        if (matchedInThisRun.has(user.userId)) continue
        const lastMatchTime = user.lastMatchAt ? new Date(user.lastMatchAt).getTime() : 0
        if (lastMatchTime > guaranteeCutoff) continue // not overdue yet

        try {
          const match = await this.attemptMatch(user.userId, 'guarantee', matchedInThisRun)
          if (match) {
            stats.matched++
            stats.guaranteed++
            const partnerId = match.user_a === user.userId ? match.user_b : match.user_a
            matchedInThisRun.add(user.userId)
            matchedInThisRun.add(partnerId)
            const detail = stats.details.find(d => d.userId === user.userId)
            if (detail) { detail.status = 'matched'; detail.matchId = match.id; detail.error = undefined }

            await db.update(blindDateDailyQueue).set({
              status: 'matched',
              matchedUserId: partnerId,
              matchId: match.id,
              processedAt: new Date().toISOString(),
            }).where(and(eq(blindDateDailyQueue.userId, user.userId), eq(blindDateDailyQueue.scheduledDate, today)))

            logger.info({ userId: user.userId, matchId: match.id }, '🔒 Weekly guarantee match created')
          }
        } catch (error) {
          logger.error({ error, userId: user.userId }, 'Error in weekly guarantee sweep')
        }
      }

      logger.info(stats, '✅ Blind dating matching pass completed')
      return stats
    } catch (error) {
      logger.error({ error }, 'Error in blind dating matching pass')
      return stats
    }
  }

  /**
   * Process daily matches for all enabled users. Called by the scheduled
   * cron job (see workers/blind-dating-scheduler.ts).
   */
  static async processDailyMatches(): Promise<{ processed: number; matched: number; errors: number }> {
    const { processed, matched, errors } = await this.runMatchingPass()
    return { processed, matched, errors }
  }

  /**
   * Force run matching for all eligible users (admin function). Runs the
   * exact same engine as processDailyMatches -- kept as a separate name
   * since existing admin routes call it on demand outside the daily
   * schedule.
   */
  static async forceMatchAllUsers(): Promise<{
    processed: number
    matched: number
    errors: number
    details: Array<{ userId: string; status: string; matchId?: string; error?: string }>
  }> {
    return this.runMatchingPass()
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


