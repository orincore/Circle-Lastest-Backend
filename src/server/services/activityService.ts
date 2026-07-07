import { and, desc, eq } from 'drizzle-orm'
import { db } from '../config/db.js'
import { activityFeed } from '../db/schema.js'
import { logger } from '../config/logger.js'
import { emitToAll, emitToUser } from '../sockets/optimized-socket.js'
import { NotificationService } from './notificationService.js'
import { PushNotificationService } from './pushNotificationService.js'

export interface ActivityData {
  type: string
  data: Record<string, any>
  timestamp?: string
  user_id?: string
}

export interface ActivityEvent {
  id: string
  type: string
  data: Record<string, any>
  timestamp: string
  user_id?: string
}

// Activity types configuration
const ACTIVITY_TYPES = {
  USER_MATCHED: 'user_matched',
  USER_JOINED: 'user_joined',
  PROFILE_VISITED: 'profile_visited',
  FRIEND_REQUEST_SENT: 'friend_request_sent',
  FRIENDS_CONNECTED: 'friends_connected',
  LOCATION_UPDATED: 'location_updated',
  CHAT_STARTED: 'chat_started',
  INTEREST_UPDATED: 'interest_updated',
} as const

// Note: Nearby user notifications (for non-friends within 3km with 5-day cooldown)
// are handled by the /api/location/check-nearby endpoint in location.routes.ts

// Live-feed location-updated activities used to fire on every profile save,
// even when the city string hadn't changed or the user had just been broadcast
// a minute earlier — spamming every other online user with "X is in <city>"
// notifications. trackLocationUpdated() below checks the activity_feed table
// (persisted, not in-memory) and skips when the location is unchanged or
// we're still within the minimum gap between broadcasts.
const LOCATION_BROADCAST_COOLDOWN_MS = 3 * 60 * 60 * 1000 // 3 hours
// Friends do NOT receive location-based notifications

// Store activities in memory for quick access (last 100 activities)
let recentActivities: ActivityEvent[] = []
const MAX_RECENT_ACTIVITIES = 100

// Privacy settings - which activities should be public (all activities are now public)
const PUBLIC_ACTIVITY_TYPES = new Set<string>([
  ACTIVITY_TYPES.USER_JOINED,
  ACTIVITY_TYPES.USER_MATCHED,
  ACTIVITY_TYPES.FRIENDS_CONNECTED,
  ACTIVITY_TYPES.LOCATION_UPDATED,
  ACTIVITY_TYPES.INTEREST_UPDATED,
  ACTIVITY_TYPES.PROFILE_VISITED,
  ACTIVITY_TYPES.FRIEND_REQUEST_SENT,
  ACTIVITY_TYPES.CHAT_STARTED,
])

// Rate limiting for activities (prevent spam)
const activityRateLimit = new Map<string, number>()
const RATE_LIMIT_WINDOW = 60000 // 1 minute
const MAX_ACTIVITIES_PER_MINUTE = 10

function checkActivityRateLimit(userId: string): boolean {
  const now = Date.now()
  const userKey = `activity_${userId}_${Math.floor(now / RATE_LIMIT_WINDOW)}`
  const currentCount = activityRateLimit.get(userKey) || 0
  
  if (currentCount >= MAX_ACTIVITIES_PER_MINUTE) {
    return false
  }
  
  activityRateLimit.set(userKey, currentCount + 1)
  
  // Cleanup old entries
  for (const [key] of activityRateLimit) {
    const keyTime = parseInt(key.split('_')[2])
    if (now - (keyTime * RATE_LIMIT_WINDOW) > RATE_LIMIT_WINDOW * 2) {
      activityRateLimit.delete(key)
    }
  }
  
  return true
}

// Send notifications for activity events
async function sendActivityNotifications(activity: ActivityEvent): Promise<void> {
  try {
    const { type, data } = activity

    switch (type) {
      case ACTIVITY_TYPES.USER_JOINED:
        // No per-user notification insert here: 'new user joined' has no real
        // recipient list (no nearby-users query exists), and the socket
        // broadcast in createActivity() already fans this out to everyone connected.
        break

      case ACTIVITY_TYPES.USER_MATCHED:
        // Notify both users about the match
        await NotificationService.createNotification({
          recipient_id: data.user1_id,
          sender_id: data.user2_id,
          type: 'new_match',
          title: '💕 New Match!',
          message: `You matched with ${data.user2_name}!`,
          data: { 
            action: 'new_match',
            matchedUserId: data.user2_id
          }
        })
        
        await NotificationService.createNotification({
          recipient_id: data.user2_id,
          sender_id: data.user1_id,
          type: 'new_match',
          title: '💕 New Match!',
          message: `You matched with ${data.user1_name}!`,
          data: { 
            action: 'new_match',
            matchedUserId: data.user1_id
          }
        })
        break

      case ACTIVITY_TYPES.FRIENDS_CONNECTED:
        // No per-user notification insert here: "notify mutual friends" has no
        // real recipient list (no mutual-friends query exists), and the socket
        // broadcast in createActivity() already fans this out to everyone connected.
        break

      case ACTIVITY_TYPES.PROFILE_VISITED:
        // Don't send notification for profile visits (too spammy)
        // Profile visit notifications are handled separately
        break

      case ACTIVITY_TYPES.LOCATION_UPDATED:
        // Location update notifications are handled by the /api/location/check-nearby endpoint
        // which sends notifications to NON-FRIENDS within 3km with 5-day cooldown
        // Friends don't get location notifications - only non-friends for discovery purposes
        logger.debug({ userId: data.user_id, location: data.location }, 'Location updated - nearby notifications handled by location API')
        break

      case ACTIVITY_TYPES.INTEREST_UPDATED:
        // No per-user notification insert here: "notify users with similar
        // interests" has no real recipient list (no interest-matching query
        // exists), and the socket broadcast in createActivity() already fans
        // this out to everyone connected.
        break

      default:
        // No notification for other activity types
        break
    }
  } catch (error) {
    logger.error({ error, activity }, 'Failed to send activity notifications')
  }
}

// Create and broadcast activity
export async function createActivity(activityData: ActivityData): Promise<void> {
  try {
    // Rate limiting check
    if (activityData.user_id && !checkActivityRateLimit(activityData.user_id)) {
      logger.warn({ userId: activityData.user_id, type: activityData.type }, 'Activity rate limit exceeded')
      return
    }

    // Check if activity type should be public
    if (!PUBLIC_ACTIVITY_TYPES.has(activityData.type)) {
      logger.debug({ type: activityData.type }, 'Activity type is not public, skipping broadcast')
      return
    }

    // Check for duplicate activities (prevent same activity within 30 seconds)
    const now = new Date()
    const thirtySecondsAgo = new Date(now.getTime() - 30000)
    
    const isDuplicate = recentActivities.some(existing => 
      existing.type === activityData.type &&
      JSON.stringify(existing.data) === JSON.stringify(activityData.data) &&
      new Date(existing.timestamp) > thirtySecondsAgo
    )
    
    if (isDuplicate) {
      logger.debug({ type: activityData.type, data: activityData.data }, 'Duplicate activity prevented')
      return
    }

    const activity: ActivityEvent = {
      id: `activity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: activityData.type,
      data: activityData.data,
      timestamp: activityData.timestamp || new Date().toISOString(),
      user_id: activityData.user_id,
    }

    // Add to recent activities (in-memory store)
    recentActivities.unshift(activity)
    if (recentActivities.length > MAX_RECENT_ACTIVITIES) {
      recentActivities = recentActivities.slice(0, MAX_RECENT_ACTIVITIES)
    }

    // Store in database for persistence (optional, for analytics)
    try {
      await db.insert(activityFeed).values({
        id: activity.id,
        type: activity.type,
        data: activity.data,
        timestamp: activity.timestamp,
        userId: activity.user_id,
      })
    } catch (dbError) {
      // Don't fail the whole operation if DB insert fails
      logger.warn({ error: dbError, activity }, 'Failed to store activity in database')
    }

    // Broadcast to all connected users
    emitToAll(`activity:${activity.type}`, activity)
    
    // Send notifications for specific activity types
    await sendActivityNotifications(activity)
    
    logger.info({ 
      activityId: activity.id, 
      type: activity.type, 
      dataKeys: Object.keys(activity.data),
      userId: activity.user_id 
    }, 'Activity created and broadcasted')

  } catch (error) {
    logger.error({ error, activityData }, 'Failed to create activity')
  }
}

// Get recent activities
export function getRecentActivities(limit: number = 20): ActivityEvent[] {
  return recentActivities.slice(0, Math.min(limit, MAX_RECENT_ACTIVITIES))
}

// Load activities from database on server startup
export async function loadActivitiesFromDatabase(): Promise<void> {
  try {
    const activities = await db.select().from(activityFeed)
      .orderBy(desc(activityFeed.timestamp))
      .limit(MAX_RECENT_ACTIVITIES)

    if (activities && activities.length > 0) {
      recentActivities = activities.map(activity => ({
        id: activity.id,
        type: activity.type,
        data: activity.data as Record<string, any>,
        timestamp: activity.timestamp,
        user_id: activity.userId ?? undefined,
      }))

      logger.info({ count: activities.length }, 'Loaded activities from database')
    }
  } catch (error) {
    logger.error({ error }, 'Failed to load activities from database')
  }
}

// Specific activity creators for common events
export async function trackUserMatched(user1: any, user2: any): Promise<void> {
  // Don't track if either user is in invisible mode
  if (user1.invisible_mode || user2.invisible_mode) {
    logger.info({ user1: user1.id, user2: user2.id }, 'Skipping match activity - user(s) in invisible mode')
    return
  }
  
  try {
    await createActivity({
      type: ACTIVITY_TYPES.USER_MATCHED,
      data: {
        user1_id: user1.id,
        user1_name: user1.first_name,
        user1_avatar: user1.profile_photo_url,
        user2_id: user2.id,
        user2_name: user2.first_name,
        user2_avatar: user2.profile_photo_url,
      },
      user_id: user1.id,
    })
  } catch (error) {
    logger.error({ error, user1: user1.id, user2: user2.id }, 'Failed to track user matched activity')
  }
}

export async function trackUserJoined(user: any): Promise<void> {
  // Don't track if user is in invisible mode
  if (user.invisible_mode) {
    logger.info({ userId: user.id }, 'Skipping user joined activity - user in invisible mode')
    return
  }
  
  try {
    await createActivity({
      type: ACTIVITY_TYPES.USER_JOINED,
      data: {
        user_id: user.id,
        user_name: user.first_name,
        user_avatar: user.profile_photo_url,
        age: user.age,
        location: user.location_city || 'Unknown',
      },
      user_id: user.id,
    })
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Failed to track user joined activity')
  }
}

export async function trackProfileVisited(visitor: any, profileOwner: any): Promise<void> {
  // Only track if it's not the user viewing their own profile
  if (visitor.id === profileOwner.id) return
  
  // Don't track if either user is in invisible mode
  if (visitor.invisible_mode || profileOwner.invisible_mode) {
    logger.info({ visitor: visitor.id, profileOwner: profileOwner.id }, 'Skipping profile visit activity - user(s) in invisible mode')
    return
  }

  try {
    await createActivity({
      type: ACTIVITY_TYPES.PROFILE_VISITED,
      data: {
        visitor_id: visitor.id,
        visitor_name: visitor.first_name,
        visitor_avatar: visitor.profile_photo_url,
        profile_id: profileOwner.id,
        profile_name: profileOwner.first_name,
        profile_avatar: profileOwner.profile_photo_url,
      },
      user_id: visitor.id,
    })
  } catch (error) {
    logger.error({ error, visitorId: visitor.id, profileId: profileOwner.id }, 'Failed to track profile visited activity')
  }
}

export async function trackFriendRequestSent(sender: any, receiver: any): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.FRIEND_REQUEST_SENT,
      data: {
        sender_id: sender.id,
        sender_name: sender.first_name,
        sender_avatar: sender.profile_photo_url,
        receiver_id: receiver.id,
        receiver_name: receiver.first_name,
        receiver_avatar: receiver.profile_photo_url,
      },
      user_id: sender.id,
    })
  } catch (error) {
    logger.error({ error, senderId: sender.id, receiverId: receiver.id }, 'Failed to track friend request sent activity')
  }
}

export async function trackFriendsConnected(user1: any, user2: any): Promise<void> {
  // Don't track if either user is in invisible mode
  if (user1.invisible_mode || user2.invisible_mode) {
    logger.info({ user1: user1.id, user2: user2.id }, 'Skipping friends connected activity - user(s) in invisible mode')
    return
  }
  
  try {
    await createActivity({
      type: ACTIVITY_TYPES.FRIENDS_CONNECTED,
      data: {
        user1_id: user1.id,
        user1_name: user1.first_name,
        user1_avatar: user1.profile_photo_url,
        user2_id: user2.id,
        user2_name: user2.first_name,
        user2_avatar: user2.profile_photo_url,
      },
      user_id: user1.id,
    })
  } catch (error) {
    logger.error({ error, user1Id: user1.id, user2Id: user2.id }, 'Failed to track friends connected activity')
  }
}

export async function trackLocationUpdated(user: any, location: string): Promise<void> {
  // Don't track if user is in invisible mode
  if (user.invisible_mode) {
    logger.info({ userId: user.id }, 'Skipping location updated activity - user in invisible mode')
    return
  }

  try {
    // Look up this user's last broadcast location_updated activity directly
    // from the activity_feed table (already written by createActivity below)
    // instead of in-memory state — an in-memory Map resets on every server
    // restart/deploy and is per-instance under horizontal scaling, so it
    // couldn't reliably suppress a duplicate broadcast across those cases.
    let lastActivity: { data: unknown; timestamp: string | null } | undefined
    try {
      const rows = await db.select({ data: activityFeed.data, timestamp: activityFeed.timestamp })
        .from(activityFeed)
        .where(and(eq(activityFeed.userId, user.id), eq(activityFeed.type, ACTIVITY_TYPES.LOCATION_UPDATED)))
        .orderBy(desc(activityFeed.timestamp))
        .limit(1)
      lastActivity = rows[0]
    } catch (lookupError) {
      logger.warn({ error: lookupError, userId: user.id }, 'Failed to look up last location broadcast, proceeding anyway')
    }

    if (lastActivity) {
      const sameLocation = (lastActivity.data as any)?.location === location
      const withinCooldown = Date.now() - new Date(lastActivity.timestamp as string).getTime() < LOCATION_BROADCAST_COOLDOWN_MS
      if (sameLocation || withinCooldown) {
        logger.debug({ userId: user.id, sameLocation, withinCooldown }, 'Skipping location updated activity - unchanged or within cooldown')
        return
      }
    }

    await createActivity({
      type: ACTIVITY_TYPES.LOCATION_UPDATED,
      data: {
        user_id: user.id,
        user_name: user.first_name,
        user_avatar: user.profile_photo_url,
        location: location,
      },
      user_id: user.id,
    })
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Failed to track location updated activity')
  }
}

export async function trackChatStarted(user1: any, user2: any): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.CHAT_STARTED,
      data: {
        user1_id: user1.id,
        user1_name: user1.first_name,
        user1_avatar: user1.profile_photo_url,
        user2_id: user2.id,
        user2_name: user2.first_name,
        user2_avatar: user2.profile_photo_url,
      },
      user_id: user1.id,
    })
  } catch (error) {
    logger.error({ error, user1Id: user1.id, user2Id: user2.id }, 'Failed to track chat started activity')
  }
}

export async function trackInterestUpdated(user: any, newInterests: string[]): Promise<void> {
  // Don't track if user is in invisible mode
  if (user.invisible_mode) {
    logger.info({ userId: user.id }, 'Skipping interest updated activity - user in invisible mode')
    return
  }
  
  try {
    await createActivity({
      type: ACTIVITY_TYPES.INTEREST_UPDATED,
      data: {
        user_id: user.id,
        user_name: user.first_name,
        user_avatar: user.profile_photo_url,
        interests: newInterests,
        interest_count: newInterests.length,
      },
      user_id: user.id,
    })
  } catch (error) {
    logger.error({ error, userId: user.id }, 'Failed to track interest updated activity')
  }
}

// Initialize activity feed table if it doesn't exist
export async function initializeActivityFeed(): Promise<void> {
  try {
    // Sanity-check that the table is reachable (table itself is managed by Drizzle migrations).
    await db.select({ id: activityFeed.id }).from(activityFeed).limit(1)
  } catch (error) {
    logger.warn({ error }, 'Could not initialize activity feed table')
  }
}

export { ACTIVITY_TYPES }
