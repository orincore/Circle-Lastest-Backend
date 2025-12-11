import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { PushNotificationService } from '../services/pushNotificationService.js'

const router = Router()

// 5-day cooldown between nearby notifications for same user pair (persisted in database)
const NOTIFICATION_COOLDOWN_DAYS = 5
const NOTIFICATION_COOLDOWN_MS = NOTIFICATION_COOLDOWN_DAYS * 24 * 60 * 60 * 1000 // 5 days in milliseconds

/**
 * Calculate distance between two coordinates using Haversine formula
 * Returns distance in kilometers
 */
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371 // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * POST /api/location/check-nearby
 * Check for nearby Circle users within specified radius and send notifications
 * Called from background location updates
 */
router.post('/check-nearby', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { latitude, longitude, radiusKm = 3 } = req.body

    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Latitude and longitude are required' })
    }

    // Get current user's profile for notification
    const { data: currentUser, error: userError } = await supabase
      .from('profiles')
      .select('first_name, last_name, username, profile_photo_url')
      .eq('id', userId)
      .single()

    if (userError || !currentUser) {
      logger.error({ error: userError, userId }, 'Failed to get current user profile')
      return res.status(500).json({ error: 'Failed to get user profile' })
    }

    // Find nearby users within radius (using PostGIS if available, otherwise manual calculation)
    // First, get users with recent location updates (within last 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    
    const { data: nearbyUsers, error: nearbyError } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, username, profile_photo_url, latitude, longitude, location_updated_at')
      .neq('id', userId)
      .not('latitude', 'is', null)
      .not('longitude', 'is', null)
      .gte('location_updated_at', twentyFourHoursAgo)
      .eq('is_suspended', false)
      .is('deleted_at', null)

    if (nearbyError) {
      logger.error({ error: nearbyError, userId }, 'Failed to query nearby users')
      return res.status(500).json({ error: 'Failed to find nearby users' })
    }

    if (!nearbyUsers || nearbyUsers.length === 0) {
      return res.json({ success: true, nearbyUsersNotified: 0, message: 'No nearby users found' })
    }

    // Get user's friends to exclude from notifications (they already get friend notifications)
    const { data: friendships } = await supabase
      .from('friendships')
      .select('user1_id, user2_id')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .eq('status', 'accepted')

    const friendIds = new Set(
      (friendships || []).map(f => f.user1_id === userId ? f.user2_id : f.user1_id)
    )

    // Get users who have blocked or been blocked by current user
    const { data: blocks } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`)

    const blockedIds = new Set(
      (blocks || []).flatMap(b => [b.blocker_id, b.blocked_id])
    )

    // Filter users within radius and not friends/blocked
    const usersWithinRadius = nearbyUsers.filter(user => {
      // Skip friends (they get separate notifications)
      if (friendIds.has(user.id)) return false
      
      // Skip blocked users
      if (blockedIds.has(user.id)) return false
      
      // Calculate distance
      const distance = calculateDistance(
        latitude, 
        longitude, 
        user.latitude!, 
        user.longitude!
      )
      
      return distance <= radiusKm
    })

    if (usersWithinRadius.length === 0) {
      return res.json({ success: true, nearbyUsersNotified: 0, message: 'No non-friend users within radius' })
    }

    // Send notifications to nearby users (with 5-day cooldown check from database)
    let notifiedCount = 0
    const now = new Date()
    const cooldownThreshold = new Date(now.getTime() - NOTIFICATION_COOLDOWN_MS)
    const currentUserName = currentUser.first_name 
      ? `${currentUser.first_name}${currentUser.last_name ? ' ' + currentUser.last_name.charAt(0) + '.' : ''}`
      : currentUser.username || 'Someone'

    for (const nearbyUser of usersWithinRadius) {
      // Check notification cooldown from database (5-day cooldown)
      const { data: recentNotification } = await supabase
        .from('nearby_notifications')
        .select('id, sent_at')
        .or(`and(from_user_id.eq.${userId},to_user_id.eq.${nearbyUser.id}),and(from_user_id.eq.${nearbyUser.id},to_user_id.eq.${userId})`)
        .gte('sent_at', cooldownThreshold.toISOString())
        .limit(1)
        .single()
      
      if (recentNotification) {
        // Skip - already notified within cooldown period
        continue
      }

      try {
        // Send push notification to the nearby user
        await PushNotificationService.sendPushNotification(nearbyUser.id, {
          title: '📍 Circle User Nearby!',
          body: `${currentUserName} is around you. Wanna check out their profile?`,
          data: {
            type: 'nearby_user',
            userId: userId,
            action: 'view_profile',
            // Deep link data for navigation
            screen: 'profile-view',
            params: { userId: userId }
          },
          sound: 'default',
          priority: 'normal'
        })

        // Record notification in database for cooldown tracking
        await supabase
          .from('nearby_notifications')
          .insert({
            from_user_id: userId,
            to_user_id: nearbyUser.id,
            sent_at: now.toISOString()
          })

        notifiedCount++

        logger.info({ 
          fromUserId: userId, 
          toUserId: nearbyUser.id,
          distance: calculateDistance(latitude, longitude, nearbyUser.latitude!, nearbyUser.longitude!),
          cooldownDays: NOTIFICATION_COOLDOWN_DAYS
        }, 'Nearby user notification sent')

      } catch (notifyError) {
        logger.error({ error: notifyError, nearbyUserId: nearbyUser.id }, 'Failed to send nearby notification')
      }
    }

    // Clean up old notification records (older than 30 days) - run occasionally
    if (Math.random() < 0.1) { // 10% chance to run cleanup
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      await supabase
        .from('nearby_notifications')
        .delete()
        .lt('sent_at', thirtyDaysAgo.toISOString())
    }

    logger.info({ 
      userId, 
      totalNearby: usersWithinRadius.length, 
      notified: notifiedCount,
      radiusKm 
    }, 'Nearby users check completed')

    res.json({ 
      success: true, 
      nearbyUsersNotified: notifiedCount,
      totalNearbyUsers: usersWithinRadius.length,
      message: notifiedCount > 0 
        ? `Notified ${notifiedCount} nearby users` 
        : 'No new users to notify (cooldown active or no users)'
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error checking nearby users')
    res.status(500).json({ error: 'Failed to check nearby users' })
  }
})

/**
 * POST /api/location/update
 * Update user's location and check for nearby users
 */
router.post('/update', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { latitude, longitude, address, city, country } = req.body

    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Latitude and longitude are required' })
    }

    // Update user's location in database
    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        latitude,
        longitude,
        location_address: address || null,
        location_city: city || null,
        location_country: country || null,
        location_updated_at: new Date().toISOString()
      })
      .eq('id', userId)

    if (updateError) {
      logger.error({ error: updateError, userId }, 'Failed to update location')
      return res.status(500).json({ error: 'Failed to update location' })
    }

    logger.info({ userId, latitude, longitude }, 'Location updated')

    res.json({ 
      success: true, 
      message: 'Location updated successfully'
    })

  } catch (error) {
    logger.error({ error, userId: req.user!.id }, 'Error updating location')
    res.status(500).json({ error: 'Failed to update location' })
  }
})

export default router
