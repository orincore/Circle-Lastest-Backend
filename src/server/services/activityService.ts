import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { emitToAll, emitToUser } from '../sockets/optimized-socket.js'

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
      const { error: dbError } = await supabase
        .from('activity_feed')
        .insert({
          id: activity.id,
          type: activity.type,
          data: activity.data,
          timestamp: activity.timestamp,
          user_id: activity.user_id,
        })
      
      if (dbError) {
        logger.warn({ error: dbError, activity }, 'Failed to store activity in database')
      }
    } catch (dbError) {
      // Don't fail the whole operation if DB insert fails
      logger.warn({ error: dbError, activity }, 'Failed to store activity in database')
    }

    // Broadcast to all connected users
    emitToAll(`activity:${activity.type}`, activity)
    
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
    const { data: activities, error } = await supabase
      .from('activity_feed')
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(MAX_RECENT_ACTIVITIES)

    if (error) {
      logger.warn({ error }, 'Failed to load activities from database')
      return
    }

    if (activities && activities.length > 0) {
      recentActivities = activities.map(activity => ({
        id: activity.id,
        type: activity.type,
        data: activity.data,
        timestamp: activity.timestamp,
        user_id: activity.user_id,
      }))
      
      logger.info({ count: activities.length }, 'Loaded activities from database')
    }
  } catch (error) {
    logger.error({ error }, 'Failed to load activities from database')
  }
}

// Specific activity creators for common events
export async function trackUserMatched(user1: any, user2: any): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.USER_MATCHED,
      data: {
        user1_id: user1.id,
        user1_name: user1.first_name,
        user2_id: user2.id,
        user2_name: user2.first_name,
      },
      user_id: user1.id,
    })
  } catch (error) {
    logger.error({ error, user1: user1.id, user2: user2.id }, 'Failed to track user matched activity')
  }
}

export async function trackUserJoined(user: any): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.USER_JOINED,
      data: {
        user_id: user.id,
        user_name: user.first_name,
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

  try {
    await createActivity({
      type: ACTIVITY_TYPES.PROFILE_VISITED,
      data: {
        visitor_id: visitor.id,
        visitor_name: visitor.first_name,
        profile_id: profileOwner.id,
        profile_name: profileOwner.first_name,
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
        receiver_id: receiver.id,
        receiver_name: receiver.first_name,
      },
      user_id: sender.id,
    })
  } catch (error) {
    logger.error({ error, senderId: sender.id, receiverId: receiver.id }, 'Failed to track friend request sent activity')
  }
}

export async function trackFriendsConnected(user1: any, user2: any): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.FRIENDS_CONNECTED,
      data: {
        user1_id: user1.id,
        user1_name: user1.first_name,
        user2_id: user2.id,
        user2_name: user2.first_name,
      },
      user_id: user1.id,
    })
  } catch (error) {
    logger.error({ error, user1Id: user1.id, user2Id: user2.id }, 'Failed to track friends connected activity')
  }
}

export async function trackLocationUpdated(user: any, location: string): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.LOCATION_UPDATED,
      data: {
        user_id: user.id,
        user_name: user.first_name,
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
        user2_id: user2.id,
        user2_name: user2.first_name,
      },
      user_id: user1.id,
    })
  } catch (error) {
    logger.error({ error, user1Id: user1.id, user2Id: user2.id }, 'Failed to track chat started activity')
  }
}

export async function trackInterestUpdated(user: any, newInterests: string[]): Promise<void> {
  try {
    await createActivity({
      type: ACTIVITY_TYPES.INTEREST_UPDATED,
      data: {
        user_id: user.id,
        user_name: user.first_name,
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
    // Check if table exists and create if needed
    const { error } = await supabase
      .from('activity_feed')
      .select('id')
      .limit(1)

    if (error && error.message.includes('does not exist')) {
      logger.info('Activity feed table does not exist, creating...')
      
      // Create table via SQL (you might want to add this to migrations instead)
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS activity_feed (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          data JSONB NOT NULL,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        
        CREATE INDEX IF NOT EXISTS idx_activity_feed_timestamp ON activity_feed(timestamp DESC);
        CREATE INDEX IF NOT EXISTS idx_activity_feed_type ON activity_feed(type);
        CREATE INDEX IF NOT EXISTS idx_activity_feed_user_id ON activity_feed(user_id);
      `
      
      // Note: You'll need to run this SQL manually or add to migrations
      logger.info('Activity feed table creation SQL prepared (run manually if needed)')
    }
  } catch (error) {
    logger.warn({ error }, 'Could not initialize activity feed table')
  }
}

export { ACTIVITY_TYPES }
