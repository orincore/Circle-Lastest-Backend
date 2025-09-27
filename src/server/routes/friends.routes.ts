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

    // Check if they are already friends (manual query)
    const smallerId = currentUserId < userId ? currentUserId : userId
    const largerId = currentUserId > userId ? currentUserId : userId
    
    const { data: friendshipData, error: friendshipError } = await supabase
      .from('friends')
      .select('*')
      .eq('user1_id', smallerId)
      .eq('user2_id', largerId)
      .maybeSingle()

    if (friendshipError && friendshipError.code !== 'PGRST116' && friendshipError.code !== '42P01') {
      // Handle missing tables gracefully
      console.warn('Friends table not found, assuming no friendship exists')
    } else if (friendshipData) {
      return res.json({ status: 'friends' })
    }

    // Check friend request status (manual query)
    const { data: requestData, error: requestError } = await supabase
      .from('friend_requests')
      .select('status')
      .or(`and(sender_id.eq.${currentUserId},receiver_id.eq.${userId}),and(sender_id.eq.${userId},receiver_id.eq.${currentUserId})`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (requestError && requestError.code !== 'PGRST116' && requestError.code !== '42P01') {
      // Handle missing tables gracefully
      console.warn('Friend_requests table not found, assuming no requests exist')
    }

    res.json({ status: requestData?.status || 'none' })
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

    console.log('Sending friend request:', { senderId, receiverId, message })

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
      .from('friends')
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
    console.log('Creating friend request in database...')
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

    console.log('Friend request created successfully:', request)
    
    // Also log all requests to see what's in the database
    const { data: allRequestsAfter } = await supabase
      .from('friend_requests')
      .select('*')
      .order('created_at', { ascending: false })
    
    console.log('All requests after creation:', allRequestsAfter)
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
      .from('friends')
      .insert({
        user1_id: smallerId,
        user2_id: largerId
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

    const { error } = await supabase
      .from('friend_requests')
      .update({ status: 'rejected' })
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
    console.log('Getting pending requests for user:', userId)
    console.log('User info:', req.user)

    // First, try a simple query without joins to see if the table exists
    const { data: requests, error } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('receiver_id', userId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Friend requests query error:', error)
      if (error.code === '42P01') {
        // Table doesn't exist
        console.log('Friend requests table does not exist yet')
        return res.json({ requests: [] })
      }
      throw error
    }

    console.log('Found requests:', requests?.length || 0)

    // If we have requests, try to get sender information
    if (requests && requests.length > 0) {
      const senderIds = requests.map(r => r.sender_id)
      
      // Try different possible users table structures
      let users = null
      let usersError = null

      // Try 'users' table first
      const { data: usersData, error: usersErr } = await supabase
        .from('users')
        .select('id, name, email')
        .in('id', senderIds)

      if (usersErr) {
        console.log('Users table query failed, trying profiles table:', usersErr.message)
        
        // Try 'profiles' table as fallback with different column names
        const { data: profilesData, error: profilesErr } = await supabase
          .from('profiles')
          .select('id, username, email, full_name, display_name')
          .in('id', senderIds)

        if (profilesErr) {
          console.log('Profiles table query also failed:', profilesErr.message)
          
          // Try with just basic columns that should exist
          const { data: basicProfilesData, error: basicProfilesErr } = await supabase
            .from('profiles')
            .select('id')
            .in('id', senderIds)
          
          if (!basicProfilesErr && basicProfilesData) {
            console.log('Basic profiles query succeeded, using fallback names')
            users = basicProfilesData.map(profile => ({
              id: profile.id,
              name: `User ${profile.id.slice(0, 8)}`,
              email: `${profile.id.slice(0, 8)}@example.com`
            }))
          }
          
          // Try auth.users view as last resort
          const { data: authUsersData, error: authUsersErr } = await supabase
            .from('auth.users')
            .select('id, email')
            .in('id', senderIds)

          if (authUsersErr) {
            console.error('All user table queries failed:', authUsersErr.message)
            usersError = authUsersErr
          } else {
            users = authUsersData?.map(user => ({
              id: user.id,
              name: user.email?.split('@')[0] || 'User', // Use email prefix as name
              email: user.email
            }))
          }
        } else {
          // Transform profiles data to match expected format
          users = profilesData?.map(profile => ({
            id: profile.id,
            name: profile.full_name || profile.display_name || profile.username || 'User',
            email: profile.email || 'unknown@example.com'
          }))
        }
      } else {
        users = usersData
      }

      if (usersError || !users) {
        console.error('Failed to get user information, using fallback')
        // Return requests with basic sender info using sender_id as name
        const requestsWithFallback = requests.map(request => ({
          ...request,
          sender: {
            id: request.sender_id,
            name: `User ${request.sender_id.slice(0, 8)}`, // Use first 8 chars of ID as name
            email: `${request.sender_id.slice(0, 8)}@example.com`
          }
        }))
        return res.json({ requests: requestsWithFallback })
      }

      // Combine requests with sender information
      const requestsWithSenders = requests.map(request => {
        const sender = users?.find(u => u.id === request.sender_id) || {
          id: request.sender_id,
          name: 'Unknown User',
          email: 'unknown@example.com'
        }
        return {
          ...request,
          sender
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

    const { data: friendships, error } = await supabase
      .from('friends')
      .select(`
        *,
        user1:user1_id(id, name, email),
        user2:user2_id(id, name, email)
      `)
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order('created_at', { ascending: false })

    if (error) throw error

    // Transform the data to get friend info
    const friends = (friendships || []).map((friendship: any) => {
      const friend = friendship.user1_id === userId ? friendship.user2 : friendship.user1
      return {
        id: friendship.id,
        friend,
        created_at: friendship.created_at
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

    // Determine the correct order for the friendship
    const smallerId = userId < friendId ? userId : friendId
    const largerId = userId > friendId ? userId : friendId

    const { error } = await supabase
      .from('friends')
      .delete()
      .eq('user1_id', smallerId)
      .eq('user2_id', largerId)

    if (error) throw error

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

    console.log('Blocking user:', { blockerId, blockedUserId, reason })

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

    console.log('Unblocking user:', { blockerId, blockedUserId })

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
      .from('friends')
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
    
    console.log('Creating friend request for specific user:', receiverId)
    
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

    console.log('Friend request created successfully:', request)
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
    
    console.log('Creating test request for user:', receiverId)
    
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

    console.log('Test request created successfully:', request)
    
    // Verify it was created by querying all requests for this user
    const { data: userRequests } = await supabase
      .from('friend_requests')
      .select('*')
      .eq('receiver_id', receiverId)
    
    console.log('All requests for user after test creation:', userRequests)

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
})

export default router
