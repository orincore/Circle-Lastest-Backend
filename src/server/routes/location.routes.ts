import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { db } from '../config/db.js'
import { blocks, friendships, nearbyNotifications, profiles } from '../db/schema.js'
import { and, eq, gte, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
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
    const [currentUser] = await db.select({
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      username: profiles.username,
      profile_photo_url: profiles.profilePhotoUrl,
    })
      .from(profiles)
      .where(eq(profiles.id, userId))
      .limit(1)

    if (!currentUser) {
      logger.error({ userId }, 'Failed to get current user profile')
      return res.status(500).json({ error: 'Failed to get user profile' })
    }

    // Find nearby users within radius (using PostGIS if available, otherwise manual calculation)
    // First, get users with recent location updates (within last 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const nearbyUsers = await db.select({
      id: profiles.id,
      first_name: profiles.firstName,
      last_name: profiles.lastName,
      username: profiles.username,
      profile_photo_url: profiles.profilePhotoUrl,
      latitude: profiles.latitude,
      longitude: profiles.longitude,
      location_updated_at: profiles.locationUpdatedAt,
    })
      .from(profiles)
      .where(and(
        ne(profiles.id, userId),
        isNotNull(profiles.latitude),
        isNotNull(profiles.longitude),
        gte(profiles.locationUpdatedAt, twentyFourHoursAgo),
        eq(profiles.isSuspended, false),
        isNull(profiles.deletedAt),
      ))

    if (!nearbyUsers || nearbyUsers.length === 0) {
      return res.json({ success: true, nearbyUsersNotified: 0, message: 'No nearby users found' })
    }

    // Get user's friends to exclude from notifications (they already get friend notifications)
    const friendshipRows = await db.select({
      user1_id: friendships.user1Id,
      user2_id: friendships.user2Id,
    })
      .from(friendships)
      .where(and(
        or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
        eq(friendships.status, 'accepted'),
      ))

    const friendIds = new Set(
      (friendshipRows || []).map(f => f.user1_id === userId ? f.user2_id : f.user1_id)
    )

    // Get users who have blocked or been blocked by current user
    const blockRows = await db.select({
      blocker_id: blocks.blockerId,
      blocked_id: blocks.blockedId,
    })
      .from(blocks)
      .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)))

    const blockedIds = new Set(
      (blockRows || []).flatMap(b => [b.blocker_id, b.blocked_id])
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
        Number(user.latitude),
        Number(user.longitude)
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
      const [recentNotification] = await db.select({
        id: nearbyNotifications.id,
        sent_at: nearbyNotifications.sentAt,
      })
        .from(nearbyNotifications)
        .where(and(
          or(
            and(eq(nearbyNotifications.fromUserId, userId), eq(nearbyNotifications.toUserId, nearbyUser.id)),
            and(eq(nearbyNotifications.fromUserId, nearbyUser.id), eq(nearbyNotifications.toUserId, userId)),
          ),
          gte(nearbyNotifications.sentAt, cooldownThreshold.toISOString()),
        ))
        .limit(1)

      if (recentNotification) {
        // Skip - already notified within cooldown period
        continue
      }

      try {
        // Get nearby user's name for notification
        const nearbyUserName = nearbyUser.first_name 
          ? `${nearbyUser.first_name}${nearbyUser.last_name ? ' ' + nearbyUser.last_name.charAt(0) + '.' : ''}`
          : nearbyUser.username || 'Someone'
        
        const distance = calculateDistance(latitude, longitude, Number(nearbyUser.latitude), Number(nearbyUser.longitude))
        
        // Send push notification to the nearby user (about current user)
        await PushNotificationService.sendPushNotification(nearbyUser.id, {
          title: '📍 Circle User Nearby!',
          body: `${currentUserName} is nearby! Tap to check out their profile.`,
          data: {
            type: 'nearby_user',
            userId: userId,
            action: 'view_profile',
            screen: 'profile-view',
            params: { userId: userId }
          },
          sound: 'default',
          priority: 'high'
        })
        
        // ALSO send push notification to current user (about nearby user) - BOTH get notified!
        await PushNotificationService.sendPushNotification(userId, {
          title: '📍 Circle User Nearby!',
          body: `${nearbyUserName} is nearby! Tap to check out their profile.`,
          data: {
            type: 'nearby_user',
            userId: nearbyUser.id,
            action: 'view_profile',
            screen: 'profile-view',
            params: { userId: nearbyUser.id }
          },
          sound: 'default',
          priority: 'high'
        })

        // Record notification in database for cooldown tracking (bidirectional)
        await db.insert(nearbyNotifications).values({
          fromUserId: userId,
          toUserId: nearbyUser.id,
          sentAt: now.toISOString(),
        })

        notifiedCount++

        logger.info({ 
          fromUserId: userId, 
          toUserId: nearbyUser.id,
          distance,
          cooldownDays: NOTIFICATION_COOLDOWN_DAYS
        }, 'Nearby user notifications sent to BOTH users')

      } catch (notifyError) {
        logger.error({ error: notifyError, nearbyUserId: nearbyUser.id }, 'Failed to send nearby notification')
      }
    }

    // Clean up old notification records (older than 30 days) - run occasionally
    if (Math.random() < 0.1) { // 10% chance to run cleanup
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      await db.delete(nearbyNotifications).where(lt(nearbyNotifications.sentAt, thirtyDaysAgo.toISOString()))
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
    try {
      await db.update(profiles).set({
        latitude: String(latitude),
        longitude: String(longitude),
        locationAddress: address || null,
        locationCity: city || null,
        locationCountry: country || null,
        locationUpdatedAt: new Date().toISOString(),
      }).where(eq(profiles.id, userId))
    } catch (updateError) {
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
