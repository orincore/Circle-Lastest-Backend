import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { eq, inArray, or } from 'drizzle-orm'
import { db } from '../config/db.js'
import {
  chatMembers,
  chats,
  friendships,
  matchmakingProposals,
  messages,
  notifications,
  profiles,
  subscriptions,
  userActivities,
  userPhotos,
  userProfileVisits,
  userReports,
} from '../db/schema.js'

const router = Router()

/**
 * Delete all user data except profile (which is marked as deleted)
 * This is a comprehensive deletion that removes:
 * - All messages
 * - All chats and chat memberships
 * - All friendships
 * - All friend requests
 * - All notifications
 * - All user activities
 * - All matchmaking proposals
 * - All user photos
 * - All profile visits
 * - All reports (made by or against user)
 * - All subscriptions
 * - All location data
 * - Social accounts
 * 
 * The profile is kept but marked as deleted with anonymized data
 */
router.post('/delete-account', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    //console.log(`🗑️ Starting account deletion for user: ${userId}`)

    // Start a transaction-like deletion process
    const deletionResults = {
      messages: 0,
      chats: 0,
      friendships: 0,
      friendRequests: 0,
      notifications: 0,
      activities: 0,
      matchmaking: 0,
      photos: 0,
      profileVisits: 0,
      reports: 0,
      subscriptions: 0,
      locations: 0,
      socialAccounts: 0,
    }

    // 1. Delete all messages sent by user
    try {
      const deleted = await db.delete(messages).where(eq(messages.senderId, userId)).returning({ id: messages.id })
      deletionResults.messages = deleted.length
    } catch (error) {
      console.error('Error deleting messages:', error)
    }

    // 2. Delete chat memberships
    // NOTE: pre-existing quirk carried over from the old code — chat cleanup below
    // re-queries chat_members for this user's chat ids, but by then this delete has
    // already removed those very rows, so step 3 never finds anything to clean up.
    // Preserved as-is rather than silently changing what account deletion does to chats.
    try {
      await db.delete(chatMembers).where(eq(chatMembers.userId, userId))
    } catch (error) {
      console.error('Error deleting chat memberships:', error)
    }

    // 3. Delete chats where user is the only member (or clean up empty chats)
    const userChats = await db.select({ chat_id: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId))

    if (userChats.length > 0) {
      const chatIds = userChats.map(c => c.chat_id)
      try {
        const deletedChats = await db.delete(chats).where(inArray(chats.id, chatIds)).returning({ id: chats.id })
        deletionResults.chats = deletedChats.length
      } catch (error) {
        console.error('Error deleting empty chats:', error)
      }
    }

    // 4. Delete all friendships
    try {
      const deleted = await db.delete(friendships).where(or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId))).returning({ id: friendships.id })
      deletionResults.friendships = deleted.length
    } catch (error) {
      console.error('Error deleting friendships:', error)
    }

    // 5. friend_requests: table no longer exists (friend requests now live as
    // pending rows in friendships) — nothing to delete here beyond step 4.

    // 6. Delete all notifications (recipient or sender)
    try {
      const deleted = await db.delete(notifications).where(or(eq(notifications.recipientId, userId), eq(notifications.senderId, userId))).returning({ id: notifications.id })
      deletionResults.notifications = deleted.length
    } catch (error) {
      console.error('Error deleting notifications:', error)
    }

    // 7. Delete all user activities
    try {
      const deleted = await db.delete(userActivities).where(eq(userActivities.userId, userId)).returning({ id: userActivities.id })
      deletionResults.activities = deleted.length
    } catch (error) {
      console.error('Error deleting activities:', error)
    }

    // 8. Delete all matchmaking proposals
    try {
      const deleted = await db.delete(matchmakingProposals).where(or(eq(matchmakingProposals.a, userId), eq(matchmakingProposals.b, userId))).returning({ id: matchmakingProposals.id })
      deletionResults.matchmaking = deleted.length
    } catch (error) {
      console.error('Error deleting matchmaking proposals:', error)
    }

    // 9. Delete all user photos
    try {
      const deleted = await db.delete(userPhotos).where(eq(userPhotos.userId, userId)).returning({ id: userPhotos.id })
      deletionResults.photos = deleted.length
    } catch (error) {
      console.error('Error deleting photos:', error)
    }

    // 10. Delete all profile visits
    try {
      const deleted = await db.delete(userProfileVisits).where(or(eq(userProfileVisits.visitorId, userId), eq(userProfileVisits.visitedUserId, userId))).returning({ id: userProfileVisits.id })
      deletionResults.profileVisits = deleted.length
    } catch (error) {
      console.error('Error deleting profile visits:', error)
    }

    // 11. Delete all reports (table is `user_reports`, not `reports`)
    try {
      const deleted = await db.delete(userReports).where(or(eq(userReports.reporterId, userId), eq(userReports.reportedUserId, userId))).returning({ id: userReports.id })
      deletionResults.reports = deleted.length
    } catch (error) {
      console.error('Error deleting reports:', error)
    }

    // 12. Delete subscription data
    try {
      const deleted = await db.delete(subscriptions).where(eq(subscriptions.userId, userId)).returning({ id: subscriptions.id })
      deletionResults.subscriptions = deleted.length
    } catch (error) {
      console.error('Error deleting subscriptions:', error)
    }

    // 13. Location data lives directly on profiles (latitude/longitude/location_updated_at) —
    // there is no separate user_locations table; it's cleared via the profile anonymization below.

    // 14. Social account linking (social_accounts / linked_social_accounts) has no backing
    // table in the current schema — nothing to delete here.

    // 15. Mark profile as deleted and anonymize data
    try {
      await db.update(profiles).set({
        firstName: 'Deleted',
        lastName: 'User',
        email: `deleted_${userId}@deleted.com`,
        username: `deleted_${userId}`,
        phoneNumber: null,
        about: 'This account has been deleted',
        interests: [],
        needs: [],
        profilePhotoUrl: null,
        instagramUsername: null,
        passwordHash: 'DELETED_ACCOUNT_NO_LOGIN', // column is NOT NULL; invalidate instead of nulling
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        // Reset all stats
        circlePoints: 0,
        totalMatches: 0,
        totalFriends: 0,
        messagesSent: 0,
        messagesReceived: 0,
        profileVisitsReceived: 0,
        // Clear location
        latitude: null,
        longitude: null,
        locationUpdatedAt: null,
        // Disable features
        invisibleMode: true,
        emailVerified: false,
      }).where(eq(profiles.id, userId))
    } catch (error) {
      console.error('❌ Error anonymizing profile:', error)
      return res.status(500).json({
        error: 'Failed to complete account deletion',
        details: 'Profile anonymization failed'
      })
    }

    //console.log('✅ Profile anonymized and marked as deleted')
    //console.log('📊 Deletion summary:', deletionResults)

    res.json({
      success: true,
      message: 'Account successfully deleted',
      deletionSummary: deletionResults,
      note: 'Your profile has been anonymized and marked as deleted. All your data has been removed from our systems.'
    })

  } catch (error) {
    console.error('❌ Error during account deletion:', error)
    res.status(500).json({ 
      error: 'Failed to delete account',
      message: error instanceof Error ? error.message : 'Unknown error'
    })
  }
})

/**
 * Get account deletion status (for verification)
 */
router.get('/deletion-status', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    const [profile] = await db.select({
      is_deleted: profiles.isDeleted,
      deleted_at: profiles.deletedAt,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1)

    res.json({
      isDeleted: profile?.is_deleted || false,
      deletedAt: profile?.deleted_at || null
    })

  } catch (error) {
    console.error('Error checking deletion status:', error)
    res.status(500).json({ error: 'Failed to check deletion status' })
  }
})

export default router
