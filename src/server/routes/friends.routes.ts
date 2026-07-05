import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { blocks, chatMembers, friendships, messages, profiles } from '../db/schema.js'
import { invalidateProfileCache } from '../services/cache.js'

const router = Router()

// Get friend status between current user and another user
router.get('/status/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const currentUserId = req.user!.id

    if (userId === currentUserId) {
      return res.json({ status: 'self' })
    }

    // Check if they are already friends in the friendships table
    // Accept both 'active' and 'accepted' status
    const [friendshipData] = await db.select().from(friendships)
      .where(and(
        or(
          and(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, userId)),
          and(eq(friendships.user1Id, userId), eq(friendships.user2Id, currentUserId)),
        ),
        inArray(friendships.status, ['active', 'accepted']),
      ))
      .limit(1)

    if (friendshipData) {
      return res.json({ status: 'friends' })
    }

    // Check for pending friend requests in friendships table
    const [pendingRequest] = await db.select({ status: friendships.status, senderId: friendships.senderId }).from(friendships)
      .where(and(
        or(
          and(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, userId)),
          and(eq(friendships.user1Id, userId), eq(friendships.user2Id, currentUserId)),
        ),
        eq(friendships.status, 'pending'),
      ))
      .limit(1)

    if (pendingRequest) {
      // Return 'pending_sent' or 'pending_received' based on who sent it
      const status = pendingRequest.senderId === currentUserId ? 'pending_sent' : 'pending_received'
      return res.json({ status })
    }

    res.json({ status: 'none' })
  } catch (error) {
    console.error('Get friend status error:', error)
    res.status(500).json({ error: 'Failed to get friend status' })
  }
})

// Get pending friend requests
router.get('/requests/pending', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    // Query friendships table for pending requests where user is the receiver
    const friendshipRows = await db.select().from(friendships)
      .where(and(
        eq(friendships.status, 'pending'),
        or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
      ))
      .orderBy(desc(friendships.createdAt))

    // Filter to only show requests where current user is the receiver (not the sender)
    const requests = friendshipRows.filter(f => f.senderId !== userId)

    // If we have requests, get sender information from profiles
    if (requests.length > 0) {
      const senderIds = requests.map(r => r.senderId!)

      // Get sender profiles - exclude suspended/deleted accounts
      let profileRows: Array<{
        id: string; firstName: string | null; lastName: string | null; username: string | null
        profilePhotoUrl: string | null; instagramUsername: string | null
      }> = []
      try {
        profileRows = await db.select({
          id: profiles.id,
          firstName: profiles.firstName,
          lastName: profiles.lastName,
          username: profiles.username,
          profilePhotoUrl: profiles.profilePhotoUrl,
          instagramUsername: profiles.instagramUsername,
        })
          .from(profiles)
          .where(and(
            inArray(profiles.id, senderIds),
            isNull(profiles.deletedAt),
            or(isNull(profiles.isSuspended), eq(profiles.isSuspended, false)),
          ))
      } catch (profilesErr) {
        console.error('Failed to get sender profiles:', profilesErr)
        // Return requests with basic sender info
        const requestsWithFallback = requests.map(request => ({
          id: request.id,
          sender_id: request.senderId,
          status: request.status,
          created_at: request.createdAt,
          sender: {
            id: request.senderId,
            name: 'Unknown User',
            profile_photo_url: null
          }
        }))
        return res.json({ requests: requestsWithFallback })
      }

      // Combine requests with sender information
      const requestsWithSenders = requests.map(request => {
        const senderProfile = profileRows.find(p => p.id === request.senderId)
        const senderName = senderProfile
          ? `${senderProfile.firstName || ''} ${senderProfile.lastName || ''}`.trim() || senderProfile.username || 'User'
          : 'Unknown User'

        return {
          id: request.id,
          sender_id: request.senderId,
          status: request.status,
          created_at: request.createdAt,
          sender: {
            id: request.senderId,
            name: senderName,
            first_name: senderProfile?.firstName || null,
            last_name: senderProfile?.lastName || null,
            username: senderProfile?.username || null,
            profile_photo_url: senderProfile?.profilePhotoUrl || null,
            instagram_username: senderProfile?.instagramUsername || null
          }
        }
      })

      res.json({ requests: requestsWithSenders })
    } else {
      res.json({ requests: [] })
    }
  } catch (error) {
    console.error('Get pending requests error:', error)
    res.status(500).json({ error: 'Failed to get pending requests' })
  }
})

// Get friends list
router.get('/list', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    // First get the friendships without joins
    // Accept both 'active' and 'accepted' status
    const friendshipRows = await db.select().from(friendships)
      .where(and(
        or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
        inArray(friendships.status, ['active', 'accepted']),
      ))
      .orderBy(desc(friendships.createdAt))

    if (friendshipRows.length === 0) {
      return res.json({ friends: [] })
    }

    // Get the friend user IDs
    const friendUserIds = friendshipRows.map(f => f.user1Id === userId ? f.user2Id : f.user1Id)

    // Get friend profiles separately - exclude suspended/deleted accounts
    let profileRows: Array<{
      id: string; firstName: string | null; lastName: string | null; email: string | null
      profilePhotoUrl: string | null; instagramUsername: string | null
    }> = []
    try {
      profileRows = await db.select({
        id: profiles.id,
        firstName: profiles.firstName,
        lastName: profiles.lastName,
        email: profiles.email,
        profilePhotoUrl: profiles.profilePhotoUrl,
        instagramUsername: profiles.instagramUsername,
      })
        .from(profiles)
        .where(and(
          inArray(profiles.id, friendUserIds),
          isNull(profiles.deletedAt),
          or(isNull(profiles.isSuspended), eq(profiles.isSuspended, false)),
        ))
    } catch (profilesError) {
      console.error('Error fetching friend profiles:', profilesError)
      // Return friendships with basic info if profiles query fails
      const friends = friendshipRows.map(friendship => {
        const friendId = friendship.user1Id === userId ? friendship.user2Id : friendship.user1Id
        return {
          id: friendId,
          name: `User ${friendId.slice(0, 8)}`,
          profile_photo_url: null,
          created_at: friendship.createdAt
        }
      })
      return res.json({ friends })
    }

    // Get chat IDs for each friendship using chat_members junction table
    // First, get all chat_ids where the current user is a member
    let userChatIds: string[] = []
    try {
      const userChatMemberships = await db.select({ chatId: chatMembers.chatId }).from(chatMembers).where(eq(chatMembers.userId, userId))
      userChatIds = userChatMemberships.map(m => m.chatId)
    } catch (userChatsError) {
      console.error('Error fetching user chats:', userChatsError)
    }

    // Get all members of those chats to find which friend is in each chat
    let allChatMembers: Array<{ chatId: string; userId: string }> = []
    try {
      if (userChatIds.length > 0) {
        allChatMembers = await db.select({ chatId: chatMembers.chatId, userId: chatMembers.userId })
          .from(chatMembers)
          .where(inArray(chatMembers.chatId, userChatIds))
      }
    } catch (membersError) {
      console.error('Error fetching chat members:', membersError)
    }

    // Create a map of friendId -> chatId for 1:1 chats
    const friendChatMap = new Map<string, string>()
    // Group members by chat_id
    const chatMembersMap = new Map<string, string[]>()
    allChatMembers.forEach(member => {
      if (!chatMembersMap.has(member.chatId)) {
        chatMembersMap.set(member.chatId, [])
      }
      chatMembersMap.get(member.chatId)!.push(member.userId)
    })

    // Find 1:1 chats (exactly 2 members)
    chatMembersMap.forEach((members, chatId) => {
      if (members.length === 2) {
        const otherUserId = members.find(id => id !== userId)
        if (otherUserId && friendUserIds.includes(otherUserId)) {
          friendChatMap.set(otherUserId, chatId)
        }
      }
    })

    // Combine friendships with profile data and chat IDs
    const friends = friendshipRows.map(friendship => {
      const friendId = friendship.user1Id === userId ? friendship.user2Id : friendship.user1Id
      const profile = profileRows.find(p => p.id === friendId)

      // Get the chat ID from the map
      const chatId = friendChatMap.get(friendId) || null

      return {
        id: friendId,
        name: profile ? `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || 'Unknown User' : `User ${friendId.slice(0, 8)}`,
        profile_photo_url: profile?.profilePhotoUrl || null,
        email: profile?.email || null,
        username: profile?.instagramUsername || null,
        created_at: friendship.createdAt,
        chat_id: chatId // Include chat ID if exists
      }
    })

    res.json({ friends })
  } catch (error) {
    console.error('Get friends list error:', error)
    res.status(500).json({ error: 'Failed to get friends list' })
  }
})

// Remove friend
router.delete('/:friendId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { friendId } = req.params
    const userId = req.user!.id

    // Mark friendship as inactive instead of deleting
    // Accept both 'active' and 'accepted' status
    await db.update(friendships)
      .set({ status: 'inactive', updatedAt: new Date().toISOString() })
      .where(and(
        or(
          and(eq(friendships.user1Id, userId), eq(friendships.user2Id, friendId)),
          and(eq(friendships.user1Id, friendId), eq(friendships.user2Id, userId)),
        ),
        inArray(friendships.status, ['active', 'accepted']),
      ))

    // Friend count changed for both users → refresh their cached profile views.
    await invalidateProfileCache(userId)
    await invalidateProfileCache(friendId)

    res.json({ success: true })
  } catch (error) {
    console.error('Remove friend error:', error)
    res.status(500).json({ error: 'Failed to remove friend' })
  }
})

// Block user
router.post('/block/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId: blockedUserId } = req.params
    const { reason } = req.body
    const blockerId = req.user!.id

    if (!blockedUserId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    if (blockedUserId === blockerId) {
      return res.status(400).json({ error: 'Cannot block yourself' })
    }

    // Use the database function to block user and handle cleanup
    try {
      await db.execute(sql`select block_user(${blockerId}::uuid, ${blockedUserId}::uuid, ${reason || null}::text)`)
    } catch (error) {
      console.error('Block user error:', error)
      // Fallback to manual blocking if function doesn't exist
      await db.insert(blocks)
        .values({ blockerId, blockedId: blockedUserId, reason: reason || null })
        .onConflictDoNothing({ target: [blocks.blockerId, blocks.blockedId] }) // Ignore duplicate
    }

    // Blocking removes any friendship between the two → refresh both profiles.
    await invalidateProfileCache(blockerId)
    await invalidateProfileCache(blockedUserId)

    res.json({ success: true })
  } catch (error) {
    console.error('Block user error:', error)
    res.status(500).json({ error: 'Failed to block user' })
  }
})

// Unblock user
router.delete('/block/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId: blockedUserId } = req.params
    const blockerId = req.user!.id

    // Use the database function to unblock user
    try {
      await db.execute(sql`select unblock_user(${blockerId}::uuid, ${blockedUserId}::uuid)`)
    } catch (error) {
      console.error('Unblock user error:', error)
      // Fallback to manual unblocking
      await db.delete(blocks).where(and(eq(blocks.blockerId, blockerId), eq(blocks.blockedId, blockedUserId)))
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Unblock user error:', error)
    res.status(500).json({ error: 'Failed to unblock user' })
  }
})

// Check if user is blocked
router.get('/block-status/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const currentUserId = req.user!.id

    if (userId === currentUserId) {
      return res.json({ isBlocked: false, isBlockedBy: false })
    }

    // Check if current user has blocked the other user
    const [isBlockedRow] = await db.select({ id: blocks.id }).from(blocks)
      .where(and(eq(blocks.blockerId, currentUserId), eq(blocks.blockedId, userId)))
      .limit(1)

    // Check if current user is blocked by the other user
    const [isBlockedByRow] = await db.select({ id: blocks.id }).from(blocks)
      .where(and(eq(blocks.blockerId, userId), eq(blocks.blockedId, currentUserId)))
      .limit(1)

    res.json({
      isBlocked: !!isBlockedRow,
      isBlockedBy: !!isBlockedByRow
    })
  } catch (error) {
    console.error('Check block status error:', error)
    res.status(500).json({ error: 'Failed to check block status' })
  }
})

// Get blocked users list
router.get('/blocked', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    const rows = await db.select({
      id: blocks.id,
      blockedId: blocks.blockedId,
      reason: blocks.reason,
      createdAt: blocks.createdAt,
    })
      .from(blocks)
      .where(eq(blocks.blockerId, userId))
      .orderBy(desc(blocks.createdAt))

    const blockedUsers = rows.map(r => ({
      id: r.id,
      blocked_id: r.blockedId,
      reason: r.reason,
      created_at: r.createdAt,
    }))

    res.json({ blockedUsers })
  } catch (error) {
    console.error('Get blocked users error:', error)
    res.status(500).json({ error: 'Failed to get blocked users' })
  }
})

// Check if user can message another user
router.get('/can-message/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const currentUserId = req.user!.id

    if (userId === currentUserId) {
      return res.json({ canMessage: true, reason: 'self' })
    }

    // Check if either user has blocked the other
    const [blockCheck] = await db.select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId }).from(blocks)
      .where(or(
        and(eq(blocks.blockerId, currentUserId), eq(blocks.blockedId, userId)),
        and(eq(blocks.blockerId, userId), eq(blocks.blockedId, currentUserId)),
      ))
      .limit(1)

    if (blockCheck) {
      const isBlockedByOther = blockCheck.blockerId === userId

      return res.json({
        canMessage: false,
        reason: isBlockedByOther ? 'blocked_by_user' : 'user_blocked',
        blocked: true
      })
    }

    // Check if they are friends (manual query)
    const smallerId = currentUserId < userId ? currentUserId : userId
    const largerId = currentUserId > userId ? currentUserId : userId

    const [friendshipData] = await db.select({ id: friendships.id }).from(friendships)
      .where(and(eq(friendships.user1Id, smallerId), eq(friendships.user2Id, largerId)))
      .limit(1)

    if (friendshipData) {
      return res.json({ canMessage: true, reason: 'friends' })
    }

    // Check if there's an existing chat between these users
    const chatMemberRows = await db.select({ chatId: chatMembers.chatId, userId: chatMembers.userId }).from(chatMembers)
      .where(inArray(chatMembers.userId, [currentUserId, userId]))

    // Find chats where both users are members
    if (chatMemberRows.length > 0) {
      const chatCounts = chatMemberRows.reduce((acc, member) => {
        acc[member.chatId] = (acc[member.chatId] || 0) + 1
        return acc
      }, {} as Record<string, number>)

      // Find chat where both users are members (count = 2)
      const sharedChatId = Object.keys(chatCounts).find(chatId => chatCounts[chatId] === 2)

      if (sharedChatId) {
        return res.json({
          canMessage: true,
          reason: 'existing_chat',
          chatId: sharedChatId
        })
      }
    }

    // No friendship, no existing chat - need to send message request
    res.json({ canMessage: false, reason: 'need_friend_request' })
  } catch (error) {
    console.error('Check can message error:', error)
    res.status(500).json({ error: 'Failed to check message permission' })
  }
})

// Test endpoint to verify the route is working
router.get('/test', (req, res) => {
  res.json({ message: 'Friends API is working!', timestamp: new Date().toISOString() })
})

// Get user profile by ID
router.get('/user/:userId/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params

    // Get complete user profile from profiles table
    const [profile] = await db.select({
      id: profiles.id,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      username: profiles.username,
      email: profiles.email,
      profilePhotoUrl: profiles.profilePhotoUrl,
      instagramUsername: profiles.instagramUsername,
      age: profiles.age,
      gender: profiles.gender,
      about: profiles.about,
      interests: profiles.interests,
      needs: profiles.needs,
      createdAt: profiles.createdAt,
      verificationStatus: profiles.verificationStatus,
      emailVerified: profiles.emailVerified,
      locationAddress: profiles.locationAddress,
      locationCity: profiles.locationCity,
      locationCountry: profiles.locationCountry,
      phoneNumber: profiles.phoneNumber,
      isSuspended: profiles.isSuspended,
      deletedAt: profiles.deletedAt,
    }).from(profiles).where(eq(profiles.id, userId)).limit(1)

    if (!profile) {
      return res.status(404).json({ error: 'User profile not found' })
    }

    // Check if user is suspended or deleted - treat as not found
    if (profile.deletedAt || profile.isSuspended) {
      return res.status(404).json({ error: 'User profile not found' })
    }

    // Get user statistics
    let stats = { friends: 0, chats: 0, messages: 0 };

    try {
      // Count friends
      const [friendsCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(friendships)
        .where(and(
          or(eq(friendships.user1Id, userId), eq(friendships.user2Id, userId)),
          eq(friendships.status, 'accepted'),
        ))

      // Count chats (where user is a member)
      const [chatsCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(chatMembers)
        .where(eq(chatMembers.userId, userId))

      // Count messages sent by user
      const [messagesCountRow] = await db.select({ count: sql<number>`count(*)::int` }).from(messages)
        .where(and(eq(messages.senderId, userId), eq(messages.isDeleted, false)))

      stats = {
        friends: friendsCountRow?.count || 0,
        chats: chatsCountRow?.count || 0,
        messages: messagesCountRow?.count || 0
      }
    } catch (statsError) {
      console.error('Error fetching user stats:', statsError)
      // Keep default stats if error
    }

    // Return complete profile data with stats and proper null handling
    const responseData = {
      id: profile.id,
      firstName: profile.firstName || null,
      lastName: profile.lastName || null,
      name: `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || 'Unknown User',
      username: profile.username || null,
      email: profile.email || null,
      profilePhotoUrl: profile.profilePhotoUrl || null,
      instagramUsername: profile.instagramUsername || null,
      age: profile.age || null,
      gender: profile.gender || null,
      about: profile.about || null,
      interests: profile.interests || [],
      needs: profile.needs || [],
      location: profile.locationAddress || profile.locationCity || profile.locationCountry || null,
      locationAddress: profile.locationAddress || null,
      locationCity: profile.locationCity || null,
      locationCountry: profile.locationCountry || null,
      phone: profile.phoneNumber || null,
      joinedDate: profile.createdAt || null,
      verification_status: profile.verificationStatus || 'unverified',
      email_verified: profile.emailVerified || false,
      stats: stats
    };

    res.json(responseData);

  } catch (error) {
    console.error('Error in user profile endpoint:', error)
    res.status(500).json({ error: 'Failed to fetch user profile' })
  }
})

export default router
