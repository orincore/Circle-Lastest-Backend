import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../config/db.js'
import { friendships, profiles, userMarketingPreferences } from '../db/schema.js'

// 'active' and 'accepted' are both used across the codebase to mean
// "currently friends" (see friends.routes.ts /list) -- 'pending' is an
// unanswered request, 'inactive' is a removed friendship.
const FRIEND_STATUSES = ['active', 'accepted'] as const

/** All friend user IDs for a user, regardless of which side of the friendship row they're on. */
export async function getFriendIds(userId: string): Promise<string[]> {
  const rows = await db.select({ user1Id: friendships.user1Id, user2Id: friendships.user2Id })
    .from(friendships)
    .where(and(
      or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
      inArray(friendships.status, FRIEND_STATUSES),
    ))
  return rows.map(f => (f.user1Id === userId ? f.user2Id : f.user1Id))
}

export interface FriendProfile {
  id: string
  firstName: string | null
  lastName: string | null
  pushEnabled: boolean
}

/**
 * Friend IDs plus enough profile data to decide whether/how to notify them:
 * excludes deleted/suspended accounts and folds in marketing push
 * preference (default true when no row exists, matching the schema
 * default) so callers don't have to join it separately.
 */
export async function getActiveFriendsForNotifications(userId: string): Promise<FriendProfile[]> {
  const friendIds = await getFriendIds(userId)
  if (friendIds.length === 0) return []

  const rows = await db.select({
    id: profiles.id,
    firstName: profiles.firstName,
    lastName: profiles.lastName,
    pushEnabled: userMarketingPreferences.pushEnabled,
  })
    .from(profiles)
    .leftJoin(userMarketingPreferences, eq(userMarketingPreferences.userId, profiles.id))
    .where(and(
      inArray(profiles.id, friendIds),
      eq(profiles.isSuspended, false),
      isNull(profiles.deletedAt),
    ))

  return rows
    .filter(r => r.pushEnabled !== false)
    .map(r => ({ id: r.id, firstName: r.firstName, lastName: r.lastName, pushEnabled: r.pushEnabled !== false }))
}

/**
 * The whole friendship graph as an adjacency map, in one query -- for
 * batch jobs that need every user's friend list (e.g. scanning all users
 * for engagement notifications), calling getFriendIds() per user would be
 * one query per user. This is one query total.
 */
export async function buildFriendshipMap(): Promise<Map<string, Set<string>>> {
  const rows = await db.select({ user1Id: friendships.user1Id, user2Id: friendships.user2Id })
    .from(friendships)
    .where(inArray(friendships.status, FRIEND_STATUSES))

  const map = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!map.has(r.user1Id)) map.set(r.user1Id, new Set())
    if (!map.has(r.user2Id)) map.set(r.user2Id, new Set())
    map.get(r.user1Id)!.add(r.user2Id)
    map.get(r.user2Id)!.add(r.user1Id)
  }
  return map
}
