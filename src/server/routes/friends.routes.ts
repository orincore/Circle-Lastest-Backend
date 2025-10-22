import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import { supabase } from '../config/supabase.js'

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
    const { data: friendshipData, error: friendshipError } = await supabase
      .from('friendships')
      .select('*')
      .or(`and(user1_id.eq.${currentUserId},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${currentUserId})`)
      .in('status', ['active', 'accepted'])
      .maybeSingle()

    //console.log(`🔍 Checking friendship between ${currentUserId} and ${userId}:`, friendshipData);

    if (friendshipError && friendshipError.code !== 'PGRST116' && friendshipError.code !== '42P01') {
      console.error('Error checking friendship:', friendshipError);
    } else if (friendshipData) {
      //console.log(`✅ Found active friendship, returning friends status`);
      return res.json({ status: 'friends' })
    }

    // Check for pending friend requests in friendships table
    const { data: pendingRequest, error: requestError } = await supabase
      .from('friendships')
      .select('status, sender_id')
      .or(`and(user1_id.eq.${currentUserId},user2_id.eq.${userId}),and(user1_id.eq.${userId},user2_id.eq.${currentUserId})`)
      .eq('status', 'pending')
      .maybeSingle()

    if (requestError && requestError.code !== 'PGRST116') {
      console.warn('Error checking pending requests:', requestError)
    }

    if (pendingRequest) {
      // Return 'pending_sent' or 'pending_received' based on who sent it
      const status = pendingRequest.sender_id === currentUserId ? 'pending_sent' : 'pending_received'
      return res.json({ status })
    }

    res.json({ status: 'none' })
  } catch (error) {
    console.error('Get friend status error:', error)
    res.status(500).json({ error: 'Failed to get friend status' })
  }
})

// Send friend request
router.post('/request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { receiverId, message } = req.body
    const senderId = req.user!.id

    //console.log('Sending friend request:', { senderId, receiverId, message })

    if (!receiverId) {
      return res.status(400).json({ error: 'Receiver ID is required' })
    }

    if (receiverId === senderId) {
      return res.status(400).json({ error: 'Cannot send friend request to yourself' })
    }

    // Check if either user has blocked the other
    const { data: blockCheck, error: blockError } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`and(blocker_id.eq.${senderId},blocked_id.eq.${receiverId}),and(blocker_id.eq.${receiverId},blocked_id.eq.${senderId})`)
      .maybeSingle()

    if (blockError && blockError.code !== 'PGRST116' && blockError.code !== '42P01') {
      throw blockError
    }

    if (blockCheck) {
      const isBlockedByOther = blockCheck.blocker_id === receiverId
      const hasBlockedOther = blockCheck.blocker_id === senderId
      
      if (isBlockedByOther) {
        return res.status(403).json({ error: 'You cannot send a friend request to this user' })
      } else if (hasBlockedOther) {
        return res.status(403).json({ error: 'You have blocked this user. Unblock them first to send a friend request.' })
      }
    }

    // Check if they are already friends (manual query)
    const smallerId = senderId < receiverId ? senderId : receiverId
    const largerId = senderId > receiverId ? senderId : receiverId
    
    const { data: friendshipData, error: friendshipError } = await supabase
      .from('friendships')
      .select('*')
      .eq('user1_id', smallerId)
      .eq('user2_id', largerId)
      .maybeSingle()

    if (friendshipError && friendshipError.code !== 'PGRST116') throw friendshipError

    if (friendshipData) {
      return res.status(400).json({ error: 'Users are already friends' })
    }

    // Check if request already exists
    const { data: existingRequest, error: existingError } = await supabase
      .from('friend_requests')
      .select('*')
      .or(`and(sender_id.eq.${senderId},receiver_id.eq.${receiverId}),and(sender_id.eq.${receiverId},receiver_id.eq.${senderId})`)
      .single()

    if (existingError && existingError.code !== 'PGRST116') throw existingError

    if (existingRequest) {
      return res.status(400).json({ error: 'Friend request already exists' })
    }

    // Create friend request
    //console.log('Creating friend request in database...')
    const { data: request, error: requestError } = await supabase
      .from('friend_requests')
      .insert({
        sender_id: senderId,
        receiver_id: receiverId,
        message: message || null,
        status: 'pending'
      })
      .select('*')
      .single()

    if (requestError) {
      console.error('Friend request creation error:', requestError)
      if (requestError.code === '42P01') {
        return res.status(500).json({ error: 'Friend requests table does not exist. Please run the database schema first.' })
      }
      throw requestError
    }

    //console.log('Friend request created successfully:', request)
    
    // Also log all requests to see what's in the database
    const { data: allRequestsAfter } = await supabase
      .from('friend_requests')
      .select('*')
      .order('created_at', { ascending: false })
    
    //console.log('All requests after creation:', allRequestsAfter)
    res.json({ request })
  } catch (error) {
    console.error('Send friend request error:', error)
    res.status(500).json({ error: 'Failed to send friend request' })
  }
})

// Accept friend request
router.post('/accept/:requestId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { requestId } = req.params
    const userId = req.user!.id

    // Get the friend request
    const { data: request, error: requestError } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('id', requestId)
      .eq('receiver_id', userId)
      .eq('status', 'pending')
      .single()

    if (requestError) {
      return res.status(400).json({ error: 'Friend request not found' })
    }

    // Update request status
    const { error: updateError } = await supabase
      .from('friend_requests')
      .update({ status: 'accepted' })
      .eq('id', requestId)

    if (updateError) throw updateError

    // Create friendship
    const smallerId = request.sender_id < request.receiver_id ? request.sender_id : request.receiver_id
    const largerId = request.sender_id > request.receiver_id ? request.sender_id : request.receiver_id

    const { error: friendshipError } = await supabase
      .from('friendships')
      .insert({
        user1_id: smallerId,
        user2_id: largerId,
        status: 'active'
      })

    if (friendshipError && friendshipError.code !== '23505') { // Ignore duplicate key error
      throw friendshipError
    }

    // Create a chat between the two users so they can message each other
    try {
      // First check if a chat already exists
      const { data: existingMembers } = await supabase
        .from('chat_members')
        .select('chat_id')
        .in('user_id', [request.sender_id, request.receiver_id])

      let sharedChatId = null
      if (existingMembers && existingMembers.length > 0) {
        const chatCounts = existingMembers.reduce((acc, member) => {
          acc[member.chat_id] = (acc[member.chat_id] || 0) + 1
          return acc
        }, {} as Record<string, number>)

        sharedChatId = Object.keys(chatCounts).find(chatId => chatCounts[chatId] === 2)
      }

      // Create new chat if none exists
      if (!sharedChatId) {
        const { data: newChat, error: chatError } = await supabase
          .from('chats')
          .insert({})
          .select('*')
          .single()

        if (!chatError && newChat) {
          // Add both users as members
          await supabase
            .from('chat_members')
            .insert([
              { chat_id: newChat.id, user_id: request.sender_id },
              { chat_id: newChat.id, user_id: request.receiver_id }
            ])
          
          sharedChatId = newChat.id
        }
      }

      res.json({ success: true, chatId: sharedChatId })
    } catch (chatError) {
      console.error('Failed to create chat after friend acceptance:', chatError)
      // Still return success for the friend request, even if chat creation failed
      res.json({ success: true })
    }
  } catch (error) {
    console.error('Accept friend request error:', error)
    res.status(500).json({ error: 'Failed to accept friend request' })
  }
})

// Reject friend request
router.post('/reject/:requestId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { requestId } = req.params
    const userId = req.user!.id

    // Delete the friend request instead of marking as rejected
    const { error } = await supabase
      .from('friend_requests')
      .delete()
      .eq('id', requestId)
      .eq('receiver_id', userId)

    if (error) throw error

    res.json({ success: true })
  } catch (error) {
    console.error('Reject friend request error:', error)
    res.status(500).json({ error: 'Failed to reject friend request' })
  }
})

// Get pending friend requests
router.get('/requests/pending', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    //console.log('Getting pending requests for user:', userId)

    // Query friendships table for pending requests where user is the receiver
    const { data: friendships, error } = await supabase
      .from('friendships')
      .select('*')
      .eq('status', 'pending')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Friend requests query error:', error)
      return res.status(500).json({ error: 'Failed to get pending requests' })
    }

    // Filter to only show requests where current user is the receiver (not the sender)
    const requests = friendships?.filter(f => f.sender_id !== userId) || []

    //console.log('Found requests:', requests?.length || 0)

    // If we have requests, get sender information from profiles
    if (requests && requests.length > 0) {
      const senderIds = requests.map(r => r.sender_id)
      
      // Get sender profiles
      const { data: profiles, error: profilesErr } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, username, profile_photo_url, instagram_username')
        .in('id', senderIds)

      if (profilesErr) {
        console.error('Failed to get sender profiles:', profilesErr)
        // Return requests with basic sender info
        const requestsWithFallback = requests.map(request => ({
          id: request.id,
          sender_id: request.sender_id,
          status: request.status,
          created_at: request.created_at,
          sender: {
            id: request.sender_id,
            name: 'Unknown User',
            profile_photo_url: null
          }
        }))
        return res.json({ requests: requestsWithFallback })
      }

      // Combine requests with sender information
      const requestsWithSenders = requests.map(request => {
        const senderProfile = profiles?.find(p => p.id === request.sender_id)
        const senderName = senderProfile 
          ? `${senderProfile.first_name || ''} ${senderProfile.last_name || ''}`.trim() || senderProfile.username || 'User'
          : 'Unknown User'
        
        return {
          id: request.id,
          sender_id: request.sender_id,
          status: request.status,
          created_at: request.created_at,
          sender: {
            id: request.sender_id,
            name: senderName,
            first_name: senderProfile?.first_name || null,
            last_name: senderProfile?.last_name || null,
            username: senderProfile?.username || null,
            profile_photo_url: senderProfile?.profile_photo_url || null,
            instagram_username: senderProfile?.instagram_username || null
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
    //console.log('Getting friends list for user:', userId)

    // First get the friendships without joins
    // Accept both 'active' and 'accepted' status
    const { data: friendships, error } = await supabase
      .from('friendships')
      .select('*')
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .in('status', ['active', 'accepted'])
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching friendships:', error)
      throw error
    }

    //console.log('Found friendships:', friendships?.length || 0)

    if (!friendships || friendships.length === 0) {
      return res.json({ friends: [] })
    }

    // Get the friend user IDs
    const friendUserIds = friendships.map((friendship: any) => {
      return friendship.user1_id === userId ? friendship.user2_id : friendship.user1_id
    })

    //console.log('Friend user IDs:', friendUserIds)

    // Get friend profiles separately
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email, profile_photo_url, instagram_username')
      .in('id', friendUserIds)

    if (profilesError) {
      console.error('Error fetching friend profiles:', profilesError)
      // Return friendships with basic info if profiles query fails
      const friends = friendships.map((friendship: any) => {
        const friendId = friendship.user1_id === userId ? friendship.user2_id : friendship.user1_id
        return {
          id: friendId,
          name: `User ${friendId.slice(0, 8)}`,
          profile_photo_url: null,
          created_at: friendship.created_at
        }
      })
      return res.json({ friends })
    }

    //console.log('Found profiles:', profiles?.length || 0)

    // Get chat IDs for each friendship using chat_members junction table
    // First, get all chat_ids where the current user is a member
    const { data: userChatMembers, error: userChatsError } = await supabase
      .from('chat_members')
      .select('chat_id')
      .eq('user_id', userId)

    if (userChatsError) {
      console.error('Error fetching user chats:', userChatsError)
    }

    const userChatIds = userChatMembers?.map(m => m.chat_id) || []

    // Get all members of those chats to find which friend is in each chat
    const { data: allChatMembers, error: membersError } = await supabase
      .from('chat_members')
      .select('chat_id, user_id')
      .in('chat_id', userChatIds)

    if (membersError) {
      console.error('Error fetching chat members:', membersError)
    }

    // Create a map of friendId -> chatId for 1:1 chats
    const friendChatMap = new Map<string, string>()
    if (allChatMembers) {
      // Group members by chat_id
      const chatMembersMap = new Map<string, string[]>()
      allChatMembers.forEach(member => {
        if (!chatMembersMap.has(member.chat_id)) {
          chatMembersMap.set(member.chat_id, [])
        }
        chatMembersMap.get(member.chat_id)!.push(member.user_id)
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
    }

    //console.log('Found chats:', friendChatMap.size)

    // Combine friendships with profile data and chat IDs
    const friends = friendships.map((friendship: any) => {
      const friendId = friendship.user1_id === userId ? friendship.user2_id : friendship.user1_id
      const profile = profiles?.find((p: any) => p.id === friendId)
      
      // Get the chat ID from the map
      const chatId = friendChatMap.get(friendId) || null
      
      return {
        id: friendId,
        name: profile ? `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Unknown User' : `User ${friendId.slice(0, 8)}`,
        profile_photo_url: profile?.profile_photo_url || null,
        email: profile?.email || null,
        username: profile?.instagram_username || null,
        created_at: friendship.created_at,
        chat_id: chatId // Include chat ID if exists
      }
    })

    //console.log('Returning friends with chat IDs:', friends)
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
    const { error } = await supabase
      .from('friendships')
      .update({ status: 'inactive', updated_at: new Date().toISOString() })
      .or(`and(user1_id.eq.${userId},user2_id.eq.${friendId}),and(user1_id.eq.${friendId},user2_id.eq.${userId})`)
      .in('status', ['active', 'accepted'])

    if (error) throw error

    //console.log(`✅ Successfully unfriended: ${userId} and ${friendId}`)
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

    //console.log('Blocking user:', { blockerId, blockedUserId, reason })

    // Use the database function to block user and handle cleanup
    const { data: success, error } = await supabase
      .rpc('block_user', {
        blocker_user_id: blockerId,
        blocked_user_id: blockedUserId,
        block_reason: reason || null
      })

    if (error) {
      console.error('Block user error:', error)
      // Fallback to manual blocking if function doesn't exist
      const { error: insertError } = await supabase
        .from('blocks')
        .insert({
          blocker_id: blockerId,
          blocked_id: blockedUserId,
          reason: reason || null
        })
      
      if (insertError && insertError.code !== '23505') { // Ignore duplicate
        throw insertError
      }
    }

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

    //console.log('Unblocking user:', { blockerId, blockedUserId })

    // Use the database function to unblock user
    const { data: success, error } = await supabase
      .rpc('unblock_user', {
        blocker_user_id: blockerId,
        blocked_user_id: blockedUserId
      })

    if (error) {
      console.error('Unblock user error:', error)
      // Fallback to manual unblocking
      const { error: deleteError } = await supabase
        .from('blocks')
        .delete()
        .eq('blocker_id', blockerId)
        .eq('blocked_id', blockedUserId)
      
      if (deleteError) throw deleteError
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
    const { data: isBlocked, error: blockedError } = await supabase
      .from('blocks')
      .select('id')
      .eq('blocker_id', currentUserId)
      .eq('blocked_id', userId)
      .maybeSingle()

    if (blockedError && blockedError.code !== 'PGRST116') throw blockedError

    // Check if current user is blocked by the other user
    const { data: isBlockedBy, error: blockedByError } = await supabase
      .from('blocks')
      .select('id')
      .eq('blocker_id', userId)
      .eq('blocked_id', currentUserId)
      .maybeSingle()

    if (blockedByError && blockedByError.code !== 'PGRST116') throw blockedByError

    res.json({ 
      isBlocked: !!isBlocked,
      isBlockedBy: !!isBlockedBy
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

    const { data: blockedUsers, error } = await supabase
      .from('blocks')
      .select(`
        id,
        blocked_id,
        reason,
        created_at
      `)
      .eq('blocker_id', userId)
      .order('created_at', { ascending: false })

    if (error) throw error

    res.json({ blockedUsers: blockedUsers || [] })
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
    const { data: blockCheck, error: blockError } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`and(blocker_id.eq.${currentUserId},blocked_id.eq.${userId}),and(blocker_id.eq.${userId},blocked_id.eq.${currentUserId})`)
      .maybeSingle()

    if (blockError && blockError.code !== 'PGRST116' && blockError.code !== '42P01') {
      throw blockError
    }

    if (blockCheck) {
      const isBlockedByOther = blockCheck.blocker_id === userId
      const hasBlockedOther = blockCheck.blocker_id === currentUserId
      
      return res.json({ 
        canMessage: false, 
        reason: isBlockedByOther ? 'blocked_by_user' : 'user_blocked',
        blocked: true
      })
    }

    // Check if they are friends (manual query)
    const smallerId = currentUserId < userId ? currentUserId : userId
    const largerId = currentUserId > userId ? currentUserId : userId
    
    const { data: friendshipData, error: friendshipError } = await supabase
      .from('friendships')
      .select('*')
      .eq('user1_id', smallerId)
      .eq('user2_id', largerId)
      .maybeSingle()

    if (friendshipError && friendshipError.code !== 'PGRST116' && friendshipError.code !== '42P01') {
      // 42P01 = table does not exist, PGRST116 = no rows found
      throw friendshipError
    }

    if (friendshipData) {
      return res.json({ canMessage: true, reason: 'friends' })
    }

    // Check if there's an existing chat between these users
    const { data: chatMembers, error: chatError } = await supabase
      .from('chat_members')
      .select('chat_id')
      .in('user_id', [currentUserId, userId])

    if (chatError) throw chatError

    // Find chats where both users are members
    if (chatMembers && chatMembers.length > 0) {
      const chatCounts = chatMembers.reduce((acc, member) => {
        acc[member.chat_id] = (acc[member.chat_id] || 0) + 1
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

// Simple endpoint to create a friend request for specific user (no auth for testing)
router.post('/debug/create-request-for-user', async (req, res) => {
  try {
    const { receiverId, senderName } = req.body
    
    if (!receiverId) {
      return res.status(400).json({ error: 'receiverId is required' })
    }
    
    const testSenderId = '22222222-2222-2222-2222-222222222222' // Different test sender
    
    //console.log('Creating friend request for specific user:', receiverId)
    
    const { data: request, error } = await supabase
      .from('friend_requests')
      .insert({
        sender_id: testSenderId,
        receiver_id: receiverId,
        message: `Hi! I'm ${senderName || 'TestUser'} and I'd like to connect with you.`,
        status: 'pending'
      })
      .select('*')
      .single()

    if (error) {
      console.error('Request creation error:', error)
      return res.status(500).json({ error: error.message })
    }

    //console.log('Friend request created successfully:', request)
    res.json({ success: true, request })
  } catch (error: any) {
    console.error('Create request error:', error)
    res.status(500).json({ error: error?.message || 'Failed to create request' })
  }
})

// Test endpoint to create a friend request for current user (for testing)
router.post('/debug/create-test-request', requireAuth, async (req: AuthRequest, res) => {
  try {
    const receiverId = req.user!.id
    const testSenderId = '11111111-1111-1111-1111-111111111111' // Fake sender ID for testing
    
    //console.log('Creating test request for user:', receiverId)
    
    // First check if a test request already exists
    const { data: existingTest } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('sender_id', testSenderId)
      .eq('receiver_id', receiverId)
      .single()
    
    if (existingTest) {
      return res.json({ success: true, message: 'Test request already exists', request: existingTest })
    }
    
    const { data: request, error } = await supabase
      .from('friend_requests')
      .insert({
        sender_id: testSenderId,
        receiver_id: receiverId,
        message: 'This is a test friend request for debugging purposes. You can accept or reject this to test the functionality.',
        status: 'pending'
      })
      .select('*')
      .single()

    if (error) {
      console.error('Test request creation error:', error)
      return res.status(500).json({ error: error.message })
    }

    //console.log('Test request created successfully:', request)
    
    // Verify it was created by querying all requests for this user
    const { data: userRequests } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('receiver_id', receiverId)
    
    //console.log('All requests for user after test creation:', userRequests)

    res.json({ success: true, request, totalUserRequests: userRequests?.length || 0 })
  } catch (error: any) {
    console.error('Create test request error:', error)
    res.status(500).json({ error: error?.message || 'Failed to create test request' })
  }
})

// Debug endpoint to show ALL friend requests (for debugging)
router.get('/debug/all-requests', async (req, res) => {
  try {
    // Get ALL friend requests in the database
    const { data: allRequests, error } = await supabase
      .from('friend_requests')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      return res.json({ 
        error: error.message,
        code: error.code,
        tableExists: false 
      })
    }

    res.json({
      tableExists: true,
      totalRequests: allRequests?.length || 0,
      allRequests: allRequests || []
    })
  } catch (error: any) {
    res.json({ error: error?.message || 'Unknown error', tableExists: false })
  }
})

// Debug endpoint to check friend requests table
router.get('/debug/requests', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    
    // Check if friend_requests table exists and get all data
    const { data: allRequests, error: allError } = await supabase
      .from('friend_requests')
      .select('*')
      .limit(10)

    if (allError) {
      return res.json({ 
        error: allError.message,
        code: allError.code,
        tableExists: false 
      })
    }

    // Get requests for this user specifically
    const { data: userRequests, error: userError } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('receiver_id', userId)

    // Test user table access
    let userTableInfo: { available: boolean; tableName: string | null; error: string | null } = { 
      available: false, 
      tableName: null, 
      error: null 
    }
    
    // Try users table
    const { data: testUsers, error: testUsersError } = await supabase
      .from('users')
      .select('id, name, email')
      .limit(1)
    
    if (!testUsersError) {
      userTableInfo = { available: true, tableName: 'users', error: null }
    } else {
      // Try profiles table with different column combinations
      const { data: testProfiles, error: testProfilesError } = await supabase
        .from('profiles')
        .select('id, username, email, full_name, display_name')
        .limit(1)
      
      if (!testProfilesError) {
        userTableInfo = { available: true, tableName: 'profiles', error: null }
      } else {
        userTableInfo = { available: false, tableName: null, error: testProfilesError.message }
      }
    }

    res.json({
      tableExists: true,
      totalRequests: allRequests?.length || 0,
      userRequests: userRequests?.length || 0,
      allRequests: allRequests || [],
      userSpecificRequests: userRequests || [],
      userId,
      userTableInfo
    })
  } catch (error: any) {
    res.json({ error: error?.message || 'Unknown error', tableExists: false })
  }
});

// Check pending friend request status between current user and another user
router.get('/pending-status/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    const currentUserId = req.user!.id
    
    // Check for pending friend requests in both directions
    const { data: sentRequest } = await supabase
      .from('friend_requests')
      .select('id')
      .eq('sender_id', currentUserId)
      .eq('receiver_id', userId)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle()
    
    if (sentRequest) {
      return res.json({
        hasPendingRequest: true,
        direction: 'sent',
        requestId: sentRequest.id
      })
    }
    
    const { data: receivedRequest } = await supabase
      .from('friend_requests')
      .select('id')
      .eq('sender_id', userId)
      .eq('receiver_id', currentUserId)
      .eq('status', 'pending')
      .limit(1)
      .maybeSingle()
    
    if (receivedRequest) {
      return res.json({
        hasPendingRequest: true,
        direction: 'received',
        requestId: receivedRequest.id
      })
    }
    
    res.json({
      hasPendingRequest: false,
      direction: null,
      requestId: null
    })
    
  } catch (error) {
    console.error('Check pending friend request error:', error)
    res.status(500).json({ error: 'Failed to check pending requests' })
  }
})

// Get user profile by ID
router.get('/user/:userId/profile', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    
    //console.log('🔍 Fetching profile for user:', userId)
    
    // Get user profile from profiles table
    const { data: profile, error } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email, profile_photo_url')
      .eq('id', userId)
      .single()
    
    if (error) {
      console.error('Error fetching user profile:', error)
      return res.status(404).json({ error: 'User profile not found' })
    }
    
    //console.log('✅ Found user profile:', profile)
    
    res.json({
      id: profile.id,
      name: `${profile.first_name || ''} ${profile.last_name || ''}`.trim() || 'Unknown User',
      profilePhotoUrl: profile.profile_photo_url,
      email: profile.email
    })
    
  } catch (error) {
    console.error('Error in user profile endpoint:', error)
    res.status(500).json({ error: 'Failed to fetch user profile' })
  }
})

export default router
