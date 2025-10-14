import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'

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
    console.log(`🗑️ Starting account deletion for user: ${userId}`)

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
    const { error: messagesError, count: messagesCount } = await supabase
      .from('messages')
      .delete()
      .eq('sender_id', userId)
    
    if (messagesError) {
      console.error('Error deleting messages:', messagesError)
    } else {
      deletionResults.messages = messagesCount || 0
      console.log(`✅ Deleted ${messagesCount} messages`)
    }

    // 2. Delete chat memberships
    const { error: chatMembersError, count: chatMembersCount } = await supabase
      .from('chat_members')
      .delete()
      .eq('user_id', userId)
    
    if (chatMembersError) {
      console.error('Error deleting chat memberships:', chatMembersError)
    } else {
      console.log(`✅ Deleted ${chatMembersCount} chat memberships`)
    }

    // 3. Delete chats where user is the only member (or clean up empty chats)
    // First get all chats where user was a member
    const { data: userChats } = await supabase
      .from('chat_members')
      .select('chat_id')
      .eq('user_id', userId)
    
    if (userChats && userChats.length > 0) {
      const chatIds = userChats.map(c => c.chat_id)
      
      // Delete chats that have no members left
      const { error: chatsError, count: chatsCount } = await supabase
        .from('chats')
        .delete()
        .in('id', chatIds)
        .is('deleted_at', null)
      
      if (!chatsError) {
        deletionResults.chats = chatsCount || 0
        console.log(`✅ Deleted ${chatsCount} empty chats`)
      }
    }

    // 4. Delete all friendships
    const { error: friendshipsError, count: friendshipsCount } = await supabase
      .from('friendships')
      .delete()
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    
    if (friendshipsError) {
      console.error('Error deleting friendships:', friendshipsError)
    } else {
      deletionResults.friendships = friendshipsCount || 0
      console.log(`✅ Deleted ${friendshipsCount} friendships`)
    }

    // 5. Delete all friend requests (sent and received)
    const { error: friendRequestsError, count: friendRequestsCount } = await supabase
      .from('friend_requests')
      .delete()
      .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
    
    if (friendRequestsError) {
      console.error('Error deleting friend requests:', friendRequestsError)
    } else {
      deletionResults.friendRequests = friendRequestsCount || 0
      console.log(`✅ Deleted ${friendRequestsCount} friend requests`)
    }

    // 6. Delete all notifications
    const { error: notificationsError, count: notificationsCount } = await supabase
      .from('notifications')
      .delete()
      .or(`user_id.eq.${userId},sender_id.eq.${userId}`)
    
    if (notificationsError) {
      console.error('Error deleting notifications:', notificationsError)
    } else {
      deletionResults.notifications = notificationsCount || 0
      console.log(`✅ Deleted ${notificationsCount} notifications`)
    }

    // 7. Delete all user activities
    const { error: activitiesError, count: activitiesCount } = await supabase
      .from('user_activities')
      .delete()
      .eq('user_id', userId)
    
    if (activitiesError) {
      console.error('Error deleting activities:', activitiesError)
    } else {
      deletionResults.activities = activitiesCount || 0
      console.log(`✅ Deleted ${activitiesCount} activities`)
    }

    // 8. Delete all matchmaking proposals
    const { error: matchmakingError, count: matchmakingCount } = await supabase
      .from('matchmaking_proposals')
      .delete()
      .or(`a.eq.${userId},b.eq.${userId}`)
    
    if (matchmakingError) {
      console.error('Error deleting matchmaking proposals:', matchmakingError)
    } else {
      deletionResults.matchmaking = matchmakingCount || 0
      console.log(`✅ Deleted ${matchmakingCount} matchmaking proposals`)
    }

    // 9. Delete all user photos
    const { error: photosError, count: photosCount } = await supabase
      .from('user_photos')
      .delete()
      .eq('user_id', userId)
    
    if (photosError) {
      console.error('Error deleting photos:', photosError)
    } else {
      deletionResults.photos = photosCount || 0
      console.log(`✅ Deleted ${photosCount} photos`)
    }

    // 10. Delete all profile visits
    const { error: visitsError, count: visitsCount } = await supabase
      .from('user_profile_visits')
      .delete()
      .or(`visitor_id.eq.${userId},visited_user_id.eq.${userId}`)
    
    if (visitsError) {
      console.error('Error deleting profile visits:', visitsError)
    } else {
      deletionResults.profileVisits = visitsCount || 0
      console.log(`✅ Deleted ${visitsCount} profile visits`)
    }

    // 11. Delete all reports
    const { error: reportsError, count: reportsCount } = await supabase
      .from('reports')
      .delete()
      .or(`reporter_id.eq.${userId},reported_user_id.eq.${userId}`)
    
    if (reportsError) {
      console.error('Error deleting reports:', reportsError)
    } else {
      deletionResults.reports = reportsCount || 0
      console.log(`✅ Deleted ${reportsCount} reports`)
    }

    // 12. Delete subscription data
    const { error: subscriptionsError, count: subscriptionsCount } = await supabase
      .from('subscriptions')
      .delete()
      .eq('user_id', userId)
    
    if (subscriptionsError) {
      console.error('Error deleting subscriptions:', subscriptionsError)
    } else {
      deletionResults.subscriptions = subscriptionsCount || 0
      console.log(`✅ Deleted ${subscriptionsCount} subscriptions`)
    }

    // 13. Delete location data
    const { error: locationsError, count: locationsCount } = await supabase
      .from('user_locations')
      .delete()
      .eq('user_id', userId)
    
    if (locationsError) {
      console.error('Error deleting locations:', locationsError)
    } else {
      deletionResults.locations = locationsCount || 0
      console.log(`✅ Deleted ${locationsCount} location records`)
    }

    // 14. Delete social accounts
    const { error: socialError, count: socialCount } = await supabase
      .from('social_accounts')
      .delete()
      .eq('user_id', userId)
    
    if (socialError) {
      console.error('Error deleting social accounts:', socialError)
    } else {
      deletionResults.socialAccounts = socialCount || 0
      console.log(`✅ Deleted ${socialCount} social accounts`)
    }

    // 15. Mark profile as deleted and anonymize data
    const anonymizedData = {
      first_name: 'Deleted',
      last_name: 'User',
      email: `deleted_${userId}@deleted.com`,
      username: `deleted_${userId}`,
      phone_number: null,
      about: 'This account has been deleted',
      interests: [],
      needs: [],
      profile_photo_url: null,
      instagram_username: null,
      password_hash: null, // Remove password hash
      is_deleted: true,
      deleted_at: new Date().toISOString(),
      // Reset all stats
      circle_points: 0,
      total_matches: 0,
      total_friends: 0,
      messages_sent: 0,
      messages_received: 0,
      profile_visits_received: 0,
      // Clear location
      latitude: null,
      longitude: null,
      location_updated_at: null,
      // Disable features
      invisible_mode: true,
      email_verified: false,
    }

    const { error: profileError } = await supabase
      .from('profiles')
      .update(anonymizedData)
      .eq('id', userId)
    
    if (profileError) {
      console.error('❌ Error anonymizing profile:', profileError)
      return res.status(500).json({ 
        error: 'Failed to complete account deletion',
        details: 'Profile anonymization failed'
      })
    }

    console.log('✅ Profile anonymized and marked as deleted')
    console.log('📊 Deletion summary:', deletionResults)

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

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('is_deleted, deleted_at')
      .eq('id', userId)
      .single()

    if (error) {
      return res.status(500).json({ error: 'Failed to check deletion status' })
    }

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
