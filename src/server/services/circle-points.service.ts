import { supabase } from '../config/supabase.js'

export interface UserStats {
  circle_points: number
  total_matches: number
  messages_sent: number
  messages_received: number
  profile_visits_received: number
  total_friends: number
  last_active: string
  stats_updated_at: string
}

export interface UserActivity {
  user_id: string
  activity_type: ActivityType
  points_change: number
  related_user_id?: string
  metadata?: Record<string, any>
}

export type ActivityType = 
  | 'match_accepted'      // +15 points
  | 'match_rejected'      // -2 points
  | 'friend_added'        // +10 points
  | 'friend_removed'      // -5 points
  | 'message_sent'        // +1 point
  | 'message_received'    // +1 point
  | 'profile_visited'     // +2 points (for the visited user)
  | 'got_blocked'         // -10 points
  | 'blocked_someone'     // -3 points
  | 'daily_login'         // +2 points
  | 'profile_completed'   // +5 points

// Optimized points mapping with dynamic scaling
const ACTIVITY_POINTS: Record<ActivityType, number> = {
  match_accepted: 20,      // Increased for successful matches
  match_rejected: -1,      // Reduced penalty to encourage exploration
  friend_added: 15,        // Increased for building connections
  friend_removed: -3,      // Reduced penalty for natural relationship changes
  message_sent: 2,         // Increased to encourage communication
  message_received: 2,     // Increased to reward engaging conversations
  profile_visited: 3,      // Increased to reward attractive profiles
  got_blocked: -8,         // Reduced but still significant penalty
  blocked_someone: -2,     // Reduced penalty for necessary blocking
  daily_login: 3,          // Increased to reward consistency
  profile_completed: 8     // Increased for complete profiles
}

// Dynamic multipliers based on user activity level
const ACTIVITY_MULTIPLIERS = {
  VERY_ACTIVE: 1.2,    // 20+ activities in last 7 days
  ACTIVE: 1.1,         // 10-19 activities in last 7 days
  MODERATE: 1.0,       // 5-9 activities in last 7 days
  LOW: 0.9,           // 1-4 activities in last 7 days
  INACTIVE: 0.8       // 0 activities in last 7 days
}

export class CirclePointsService {
  
  /**
   * Get user's activity level based on recent activities
   */
  static async getUserActivityLevel(userId: string): Promise<keyof typeof ACTIVITY_MULTIPLIERS> {
    try {
      const sevenDaysAgo = new Date()
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
      
      const { data, error } = await supabase
        .from('user_activities')
        .select('id')
        .eq('user_id', userId)
        .gte('created_at', sevenDaysAgo.toISOString())
      
      if (error) {
        console.error('Error fetching user activity level:', error)
        return 'MODERATE'
      }
      
      const activityCount = data?.length || 0
      
      if (activityCount >= 20) return 'VERY_ACTIVE'
      if (activityCount >= 10) return 'ACTIVE'
      if (activityCount >= 5) return 'MODERATE'
      if (activityCount >= 1) return 'LOW'
      return 'INACTIVE'
      
    } catch (error) {
      console.error('Error in getUserActivityLevel:', error)
      return 'MODERATE'
    }
  }
  
  /**
   * Record a user activity and update their Circle points with dynamic scaling
   */
  static async recordActivity(activity: UserActivity): Promise<void> {
    try {
      // Get base points for this activity type
      const basePoints = activity.points_change || ACTIVITY_POINTS[activity.activity_type] || 0
      
      // Get user's activity level for dynamic scaling
      const activityLevel = await this.getUserActivityLevel(activity.user_id)
      const multiplier = ACTIVITY_MULTIPLIERS[activityLevel]
      
      // Apply dynamic scaling (only for positive activities to encourage engagement)
      const scaledPoints = basePoints > 0 ? Math.round(basePoints * multiplier) : basePoints
      
      // Insert activity record
      const { error: insertError } = await supabase
        .from('user_activities')
        .insert({
          user_id: activity.user_id,
          activity_type: activity.activity_type,
          points_change: scaledPoints,
          related_user_id: activity.related_user_id,
          metadata: {
            ...activity.metadata,
            base_points: basePoints,
            activity_level: activityLevel,
            multiplier: multiplier,
            scaled_points: scaledPoints
          }
        })
      
      if (insertError) {
        console.error('Error recording user activity:', insertError)
        return
      }
      
      // Recalculate and update Circle points
      await this.updateCirclePoints(activity.user_id)
      
      //console.log(`✅ Recorded activity: ${activity.activity_type} for user ${activity.user_id} (${basePoints} → ${scaledPoints} points, ${activityLevel})`)
      
    } catch (error) {
      console.error('Error in recordActivity:', error)
    }
  }
  
  /**
   * Update Circle points for a user based on all their activities
   */
  static async updateCirclePoints(userId: string): Promise<number> {
    try {
      const { data, error } = await supabase
        .rpc('calculate_circle_points', { user_uuid: userId })
      
      if (error) {
        console.error('Error calculating Circle points:', error)
        return 0
      }
      
      return data || 0
    } catch (error) {
      console.error('Error in updateCirclePoints:', error)
      return 0
    }
  }
  
  /**
   * Update all user statistics
   */
  static async updateUserStats(userId: string): Promise<void> {
    try {
      //console.log('🔄 Calling update_user_stats function for user:', userId)
      
      const { data, error } = await supabase
        .rpc('update_user_stats', { user_uuid: userId })
      
      if (error) {
        console.error('❌ Error updating user stats:', error)
        throw error
      }
      
      //console.log('✅ User stats updated successfully for user:', userId)
      
    } catch (error) {
      console.error('❌ Error in updateUserStats:', error)
      throw error
    }
  }
  
  /**
   * Get comprehensive user statistics
   */
  static async getUserStats(userId: string): Promise<UserStats | null> {
    try {
      //console.log('📊 Fetching user stats from database for user:', userId)
      
      const { data, error } = await supabase
        .from('profiles')
        .select(`
          circle_points,
          total_matches,
          messages_sent,
          messages_received,
          profile_visits_received,
          total_friends,
          last_active,
          stats_updated_at
        `)
        .eq('id', userId)
        .maybeSingle()
      
      if (error) {
        console.error('❌ Error fetching user stats:', error)
        return null
      }
      
      // If no data found, return null instead of throwing error
      if (!data) {
        console.log('⚠️ No stats found for user:', userId)
        return null
      }
      
      //console.log('📈 Raw database stats:', data)
      
      return data as UserStats
    } catch (error) {
      console.error('❌ Error in getUserStats:', error)
      return null
    }
  }
  
  /**
   * Record a profile visit
   */
  static async recordProfileVisit(visitorId: string, visitedUserId: string): Promise<void> {
    try {
      // Don't record self-visits
      if (visitorId === visitedUserId) return
      
      // Check if visit record already exists
      const { data: existingVisit } = await supabase
        .from('user_profile_visits')
        .select('visit_count')
        .eq('visitor_id', visitorId)
        .eq('visited_user_id', visitedUserId)
        .single()
      
      if (existingVisit) {
        // Update existing record - increment visit count
        const { error } = await supabase
          .from('user_profile_visits')
          .update({
            visit_count: existingVisit.visit_count + 1,
            last_visit_at: new Date().toISOString()
          })
          .eq('visitor_id', visitorId)
          .eq('visited_user_id', visitedUserId)
        
        if (error) {
          console.error('Error updating profile visit:', error)
          return
        }
        
        //console.log(`✅ Updated profile visit count to ${existingVisit.visit_count + 1} for visitor ${visitorId} → visited ${visitedUserId}`)
      } else {
        // Create new visit record
        const { error } = await supabase
          .from('user_profile_visits')
          .insert({
            visitor_id: visitorId,
            visited_user_id: visitedUserId,
            visit_count: 1,
            first_visit_at: new Date().toISOString(),
            last_visit_at: new Date().toISOString()
          })
        
        if (error) {
          console.error('Error creating profile visit:', error)
          return
        }
        
        //console.log(`✅ Created new profile visit record for visitor ${visitorId} → visited ${visitedUserId}`)
      }
      
      // Award points to the visited user
      await this.recordActivity({
        user_id: visitedUserId,
        activity_type: 'profile_visited',
        points_change: ACTIVITY_POINTS.profile_visited,
        related_user_id: visitorId,
        metadata: { visit_timestamp: new Date().toISOString() }
      })
      
    } catch (error) {
      console.error('Error in recordProfileVisit:', error)
    }
  }
  
  /**
   * Update user's last active timestamp
   */
  static async updateLastActive(userId: string): Promise<void> {
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ last_active: new Date().toISOString() })
        .eq('id', userId)
      
      if (error) {
        console.error('Error updating last active:', error)
      }
    } catch (error) {
      console.error('Error in updateLastActive:', error)
    }
  }
  
  /**
   * Get performance-based message for Circle score with activity insights
   */
  static async getPerformanceMessage(stats: UserStats, userId: string): Promise<string> {
    const { circle_points, total_matches, total_friends, messages_sent, messages_received } = stats
    
    // Get activity level for personalized messaging
    const activityLevel = await this.getUserActivityLevel(userId)
    const activityBonus = activityLevel === 'VERY_ACTIVE' ? ' You\'re on fire! 🔥' : 
                         activityLevel === 'ACTIVE' ? ' Keep it up! 💪' :
                         activityLevel === 'LOW' ? ' More activity = more points!' :
                         activityLevel === 'INACTIVE' ? ' Come back and engage more!' : ''
    
    // High performer (150+ points)
    if (circle_points >= 150) {
      return `🌟 You're a Circle superstar! Your engagement is inspiring others.${activityBonus}`
    }
    
    // Good performer (120-149 points)
    if (circle_points >= 120) {
      return `🔥 Your Circle score is rising! Keep up the great connections.${activityBonus}`
    }
    
    // Average performer (80-119 points)
    if (circle_points >= 80) {
      return `📈 Your Circle is growing steadily. More interactions = higher score!${activityBonus}`
    }
    
    // Below average (50-79 points)
    if (circle_points >= 50) {
      return `💪 Time to boost your Circle! Try messaging friends and making matches.${activityBonus}`
    }
    
    // Low performer (20-49 points)
    if (circle_points >= 20) {
      return `🚀 Let's get your Circle score up! Start by completing your profile.${activityBonus}`
    }
    
    // Very low performer (0-19 points)
    return `✨ Welcome to Circle! Complete your profile and start connecting to earn points.${activityBonus}`
  }
  
  /**
   * Get improvement suggestions based on user stats
   */
  static getImprovementSuggestions(stats: UserStats): string[] {
    const suggestions: string[] = []
    const { total_matches, total_friends, messages_sent, profile_visits_received } = stats
    
    if (total_matches < 5) {
      suggestions.push("Try the matching feature to find compatible people")
    }
    
    if (total_friends < 3) {
      suggestions.push("Send friend requests to people you connect with")
    }
    
    if (messages_sent < 10) {
      suggestions.push("Start conversations with your matches and friends")
    }
    
    if (profile_visits_received < 5) {
      suggestions.push("Update your profile with a great photo and bio")
    }
    
    return suggestions
  }
  
  /**
   * Batch update Circle points for multiple users (for performance)
   */
  static async batchUpdateCirclePoints(userIds: string[]): Promise<void> {
    try {
      const batchSize = 10 // Process in batches to avoid overwhelming the database
      
      for (let i = 0; i < userIds.length; i += batchSize) {
        const batch = userIds.slice(i, i + batchSize)
        
        // Process batch in parallel
        await Promise.all(
          batch.map(userId => this.updateCirclePoints(userId))
        )
        
        // Small delay between batches to prevent database overload
        if (i + batchSize < userIds.length) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      
      //console.log(`✅ Batch updated Circle points for ${userIds.length} users`)
      
    } catch (error) {
      console.error('Error in batchUpdateCirclePoints:', error)
    }
  }
  
  /**
   * Get leaderboard of top Circle score users
   */
  static async getLeaderboard(limit: number = 10): Promise<Array<{id: string, circle_points: number, first_name: string, last_name: string}>> {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, circle_points, first_name, last_name')
        .order('circle_points', { ascending: false })
        .limit(limit)
      
      if (error) {
        console.error('Error fetching leaderboard:', error)
        return []
      }
      
      return data || []
      
    } catch (error) {
      console.error('Error in getLeaderboard:', error)
      return []
    }
  }
}
