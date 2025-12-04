import { Server as IOServer } from 'socket.io'
import type { Server } from 'http'
import { createAdapter } from '@socket.io/redis-adapter'
import { logger } from '../config/logger.js'
import { verifyJwt } from '../utils/jwt.js'
import { setTyping, getTyping } from '../services/chat.js'
import { getChatMessages, insertMessage, insertReceipt, deleteMessage, editMessage, addReaction, toggleReaction, removeReaction } from '../repos/chat.repo.js'
import { supabase } from '../config/supabase.js'
import { getStatus } from '../services/matchmaking-optimized.js'
import { NotificationService } from '../services/notificationService.js'
import { getRecentActivities, trackFriendRequestSent, trackFriendsConnected, trackProfileVisited } from '../services/activityService.js'
import { setupVoiceCallHandlers, registerTestHandlers } from '../handlers/voiceCallHandler.js'
import { setupFriendRequestHandlers } from '../handlers/friendRequestHandler.js'
import { setupBlindDatingHandlers } from '../handlers/blindDatingHandler.js'
import { Redis } from 'ioredis'

// Helper function to calculate and emit unread count for a specific chat
async function emitUnreadCountUpdate(chatId: string, userId: string) {
  try {
    // Get unread count for this specific chat and user
    const { data: msgs, error: msgsErr } = await supabase
      .from('messages')
      .select('id,sender_id')
      .eq('chat_id', chatId)
      .eq('is_deleted', false)
      .not('sender_id', 'eq', userId)
    
    if (msgsErr) {
      console.error('Error fetching messages for unread count:', msgsErr)
      return
    }
    
    const msgIds = (msgs || []).map(m => m.id)
    let readIds: string[] = []
    
    if (msgIds.length) {
      const { data: reads, error: rErr } = await supabase
        .from('message_receipts')
        .select('message_id')
        .eq('status', 'read')
        .eq('user_id', userId)
        .in('message_id', msgIds)
      
      if (rErr) {
        console.error('Error fetching read receipts:', rErr)
        return
      }
      
      readIds = (reads || []).map(r => r.message_id)
    }
    
    const unreadCount = msgIds.filter(id => !readIds.includes(id)).length
    
    //console.log(`📊 Emitting unread count update: chat ${chatId}, user ${userId}, count ${unreadCount}`)
    emitToUser(userId, 'chat:unread_count', { chatId, unreadCount })
    
  } catch (error) {
    console.error('Error calculating/emitting unread count:', error)
  }
}

// Redis client for connection management and rate limiting
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

// Connection limits and rate limiting constants
const MAX_CONNECTIONS_PER_USER = 3
const MAX_TOTAL_CONNECTIONS = 10000
const RATE_LIMIT_WINDOW = 60 // seconds
const RATE_LIMIT_MAX_EVENTS = 100 // events per window per user
const CONNECTION_TIMEOUT = 30000 // 30 seconds idle timeout

// Connection tracking
const connectionCounts = new Map<string, number>() // userId -> connection count
let totalConnections = 0

// Rate limiting helper
async function checkEventRateLimit(userId: string, event: string): Promise<boolean> {
  try {
    const key = `socket_rate_limit:${userId}:${event}`
    const current = await redis.incr(key)
    if (current === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW)
    }
    return current <= RATE_LIMIT_MAX_EVENTS
  } catch (error) {
    logger.error({ error, userId, event }, 'Rate limit check failed')
    return true // Allow on error to prevent blocking legitimate users
  }
}

// Connection management
function canAcceptConnection(userId?: string): boolean {
  if (totalConnections >= MAX_TOTAL_CONNECTIONS) {
    return false
  }
  
  if (userId) {
    const userConnections = connectionCounts.get(userId) || 0
    if (userConnections >= MAX_CONNECTIONS_PER_USER) {
      return false
    }
  }
  
  return true
}

function trackConnection(userId?: string): void {
  totalConnections++
  if (userId) {
    connectionCounts.set(userId, (connectionCounts.get(userId) || 0) + 1)
  }
}

function untrackConnection(userId?: string): void {
  totalConnections = Math.max(0, totalConnections - 1)
  if (userId) {
    const current = connectionCounts.get(userId) || 0
    if (current <= 1) {
      connectionCounts.delete(userId)
    } else {
      connectionCounts.set(userId, current - 1)
    }
  }
}

let ioRef: IOServer | null = null

// Check for pending matchmaking proposals when user connects
async function checkPendingProposals(userId: string) {
  try {
    const status = await getStatus(userId)
    
    if (status.state === 'proposal' && status.proposal) {
      // Send the proposal notification
      emitToUser(userId, 'matchmaking:proposal', {
        id: status.proposal.id,
        other: status.proposal.other
      })
      
      // Also send acceptance notification if other user already accepted
      if (status.proposal.acceptedByOther && status.proposal.message) {
        emitToUser(userId, 'matchmaking:accepted_by_other', {
          by: status.proposal.other.first_name,
          message: status.proposal.message
        })
      }
    } else if (status.state === 'matched' && status.match) {
      // Send match completion notification
      emitToUser(userId, 'matchmaking:matched', {
        chatId: status.match.chatId,
        otherName: status.match.otherName,
        message: status.message || 'You got a match!'
      })
    }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to check pending proposals')
  }
}

export function emitToUser(userId: string, event: string, payload: any) {
  try {
    if (!ioRef) {
      logger.warn({ userId, event }, 'Socket.IO not initialized - cannot emit to user')
      return
    }
    
    const room = ioRef.sockets.adapter.rooms.get(userId)
    const connectedSockets = room ? room.size : 0
    
    logger.info({ 
      userId, 
      event, 
      connectedSockets,
      payloadKeys: Object.keys(payload || {})
    }, '📡 Emitting to user')
    
    ioRef.to(userId).emit(event, payload)
    
    if (connectedSockets === 0) {
      logger.warn({ userId, event }, '⚠️ No connected sockets for user - event may not be received')
    }
  } catch (error) {
    logger.error({ error, userId, event }, 'Failed to emit to user')
  }
}

export function emitToAll(event: string, payload: any) {
  try {
    if (!ioRef) {
      logger.warn({ event }, 'Socket.IO not initialized - cannot emit to all')
      return
    }
    
    logger.info({ 
      event, 
      connectedSockets: ioRef.sockets.sockets.size,
      payloadKeys: Object.keys(payload || {})
    }, '📡 Broadcasting to all users')
    
    ioRef.emit(event, payload)
  } catch (error) {
    logger.error({ error, event }, 'Failed to emit to all users')
  }
}

export function initOptimizedSocket(server: Server) {
  // Allow localhost for development testing even in production
  const allowedOrigins = [
    'https://circle.orincore.com',
    'https://api.circle.orincore.com',
    'http://localhost:8081',
    'http://localhost:8080',
    'http://localhost:3000',
  ]
  
  const io = new IOServer(server, {
    path: '/ws',
    cors: { 
      origin: process.env.NODE_ENV === 'production' 
        ? allowedOrigins
        : '*', 
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // Optimized for EC2 backend (no serverless limitations)
    pingTimeout: 60000,
    pingInterval: 25000,
    upgradeTimeout: 10000,
    maxHttpBufferSize: 1e6, // 1MB
    // Standard transport configuration (WebSocket first for EC2)
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    // Standard production settings
    serveClient: false,
  })
  
  ioRef = io
  
  // Setup Redis adapter for horizontal scaling (multiple Socket.IO instances)
  if (process.env.SOCKET_REDIS_ENABLED === 'true') {
    try {
      const pubClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        maxRetriesPerRequest: 3,
      })
      const subClient = pubClient.duplicate()
      
      io.adapter(createAdapter(pubClient, subClient))
      logger.info('Socket.IO Redis adapter enabled for horizontal scaling')
    } catch (error) {
      logger.error({ error }, 'Failed to setup Redis adapter for Socket.IO')
    }
  }
  
  // Initialize push notification service with IO reference
  import('../services/pushNotificationService.js').then(({ PushNotificationService }) => {
    PushNotificationService.setIoRef(io)
  }).catch(err => {
    logger.error({ error: err }, 'Failed to initialize push notification service')
  })

  // Enhanced authentication middleware with connection limits
  io.use(async (socket, next) => {
    try {
      const rawHeader = socket.handshake.headers.authorization?.toString()
      const token = (socket.handshake.auth?.token as string | undefined) || 
                   (rawHeader?.startsWith('Bearer ') ? rawHeader.slice(7) : undefined)
      
      let userId: string | undefined
      
      if (token) {
        const payload = verifyJwt<{ sub: string; email: string; username: string }>(token)
        if (payload) {
          userId = payload.sub
          ;(socket.data as any).user = { 
            id: payload.sub, 
            email: payload.email, 
            username: payload.username 
          }
        }
      }
      
      // Check connection limits
      if (!canAcceptConnection(userId)) {
        logger.warn({ userId, totalConnections }, 'Connection rejected due to limits')
        return next(new Error('Connection limit exceeded'))
      }
      
      // Track connection
      trackConnection(userId)
      
      // Set connection timeout
      const timeout = setTimeout(() => {
        logger.info({ socketId: socket.id, userId }, 'Socket connection timed out')
        socket.disconnect(true)
      }, CONNECTION_TIMEOUT)
      
      ;(socket.data as any).timeout = timeout
      ;(socket.data as any).userId = userId
      
      next()
    } catch (error) {
      logger.error({ error }, 'Socket authentication failed')
      next(new Error('Authentication failed'))
    }
  })

  const roomCounts = new Map<string, number>() // key: chat:{chatId} -> count
  const activeCounts = new Map<string, number>() // key: chat:{chatId} -> active viewers (foreground)

  function bumpRoom(io: IOServer, room: string, delta: number) {
    const prev = roomCounts.get(room) || 0
    const next = Math.max(0, prev + delta)
    roomCounts.set(room, next)
    const chatId = room.startsWith('chat:') ? room.slice(5) : undefined
    if (chatId) {
      // Emit both `online` and `isOnline` for backward/forward compatibility with clients
      const isOnline = next > 1
      io.to(room).emit('chat:presence', { chatId, online: isOnline, isOnline })
    }
  }

  function bumpActive(io: IOServer, room: string, delta: number) {
    const prev = activeCounts.get(room) || 0
    const next = Math.max(0, prev + delta)
    activeCounts.set(room, next)
    const chatId = room.startsWith('chat:') ? room.slice(5) : undefined
    if (chatId) {
      const isActive = next > 0
      io.to(room).emit('chat:presence:active', { chatId, isActive })
    }
  }

  io.on('connection', (socket) => {
    const user = (socket.data as any).user
    const userId = (socket.data as any).userId
    
    logger.info({ 
      id: socket.id, 
      user, 
      totalConnections,
      userConnections: userId ? connectionCounts.get(userId) : 0
    }, 'socket connected')

    // Join user room for direct messaging with enhanced verification
    if (user?.id) {
      try { 
        // Join user room
        socket.join(user.id)
        
        // Verify room membership
        const isInRoom = socket.rooms.has(user.id);
       
        
        if (!isInRoom) {
          console.warn(`⚠️ Failed to join room ${user.id}, retrying...`);
          socket.join(user.id);
          
          // Final verification
          const retrySuccess = socket.rooms.has(user.id);
          //console.log(`🔄 Retry result for ${user.id}:`, retrySuccess);
        }
        
        // Check for pending matchmaking proposals when user connects
        checkPendingProposals(user.id)
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Failed to join user room')
      }
    }

    // Reset connection timeout on activity
    const resetTimeout = () => {
      const timeout = (socket.data as any).timeout
      if (timeout) {
        clearTimeout(timeout)
        ;(socket.data as any).timeout = setTimeout(() => {
          logger.info({ socketId: socket.id, userId }, 'Socket connection timed out')
          socket.disconnect(true)
        }, CONNECTION_TIMEOUT)
      }
    }

    // Ping/pong with rate limiting
    socket.on('ping', async () => {
      resetTimeout()
      if (userId && !(await checkEventRateLimit(userId, 'ping'))) {
        logger.warn({ userId, socketId: socket.id }, 'Ping rate limit exceeded')
        return
      }
      socket.emit('pong', { ts: Date.now() })
    })

    // Broadcast with rate limiting
    socket.on('broadcast', async (payload) => {
      resetTimeout()
      if (userId && !(await checkEventRateLimit(userId, 'broadcast'))) {
        logger.warn({ userId, socketId: socket.id }, 'Broadcast rate limit exceeded')
        return
      }
      io.emit('broadcast', { from: user?.id, payload })
    })

    // Chat: mark message as delivered
    socket.on('chat:message:delivered', async ({ messageId }: { messageId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      //console.log(`📨 Received delivery event for message ${messageId} from user ${userId}`)
      
      if (!messageId || !userId) {
        //console.log('❌ Missing messageId or userId for delivery')
        return
      }

      try {
        // Get message to find chat ID
        const { data: message, error } = await supabase
          .from('messages')
          .select('chat_id, sender_id')
          .eq('id', messageId)
          .single()

        if (error || !message) {
          //console.log('❌ Message not found or error:', error)
          return
        }

        // Don't mark own messages as delivered
        if (message.sender_id === userId) {
          //console.log('❌ User trying to mark own message as delivered')
          return
        }

        //console.log(`✅ Adding delivery receipt for message ${messageId}`)
        
        // Add delivery receipt - use insertReceipt function which handles conflicts properly
        try {
          await insertReceipt(messageId, userId, 'delivered')
        } catch (error) {
          console.error('❌ Error inserting delivery receipt:', error)
          return
        }

        //console.log(`✅ Delivery receipt added, notifying sender ${message.sender_id}`)

        // Notify sender
        io.to(message.sender_id).emit('chat:message:delivery_receipt', {
          messageId,
          userId,
          status: 'delivered',
          chatId: message.chat_id
        })
      } catch (error) {
        logger.error({ error, messageId, userId }, 'Failed to mark message as delivered')
      }
    })

    // Chat: typing indicator (start/stop) with chat list notification
    socket.on('chat:typing', async (payload: { chatId: string; isTyping?: boolean; typing?: boolean }) => {
      resetTimeout()
      const { chatId } = payload || ({} as any)
      // Support both new `isTyping` field and legacy `typing` field from clients
      const isTyping = typeof payload.isTyping === 'boolean' ? payload.isTyping : !!payload.typing
      const currentUserId: string | undefined = user?.id
      if (!chatId || !currentUserId) return

      try {
        // Rate limit typing events
        if (!(await checkEventRateLimit(currentUserId, 'chat:typing'))) {
          logger.warn({ userId: currentUserId, socketId: socket.id }, 'Chat typing rate limit exceeded')
          return
        }

        // Update typing state in memory
        setTyping(chatId, currentUserId, !!isTyping)
        const usersTyping = getTyping(chatId)

        // Broadcast to chat room for in-conversation UI
        const room = `chat:${chatId}`
        io.to(room).emit('chat:typing', { chatId, users: usersTyping })

        // Notify other chat members for chat list badges
        const { data: members } = await supabase
          .from('chat_members')
          .select('user_id')
          .eq('chat_id', chatId)

        if (members) {
          for (const m of members) {
            if (m.user_id !== currentUserId) {
              emitToUser(m.user_id, 'chat:list:typing', {
                chatId,
                by: currentUserId,
                isTyping: !!isTyping,
              })
            }
          }
        }
      } catch (error) {
        logger.error({ error, chatId, currentUserId }, 'Failed to process typing event')
      }
    })

    // Chat: mark message as read
    socket.on('chat:message:read', async ({ messageId }: { messageId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      //console.log(`👁️ Received read event for message ${messageId} from user ${userId}`)
      
      if (!messageId || !userId) {
        //console.log('❌ Missing messageId or userId for read')
        return
      }

      try {
        // Get message to find chat ID
        const { data: message, error } = await supabase
          .from('messages')
          .select('chat_id, sender_id')
          .eq('id', messageId)
          .single()

        if (error || !message) {
          //console.log('❌ Message not found or error:', error)
          return
        }

        // Don't mark own messages as read
        if (message.sender_id === userId) {
          //console.log('❌ User trying to mark own message as read')
          return
        }

        //console.log(`✅ Adding read receipt for message ${messageId}`)

        // Add read receipt - use insertReceipt function which handles conflicts properly
        try {
          await insertReceipt(messageId, userId, 'read')
        } catch (error) {
          console.error('❌ Error inserting read receipt:', error)
          return
        }

        //console.log(`✅ Read receipt added, notifying sender ${message.sender_id}`)

        // Notify sender
        io.to(message.sender_id).emit('chat:message:read_receipt', {
          messageId,
          userId,
          status: 'read',
          chatId: message.chat_id
        })

        // Also emit to chat room for real-time updates
        io.to(`chat:${message.chat_id}`).emit('chat:read', {
          chatId: message.chat_id,
          messageId,
          by: userId
        })
        
        // Emit unread count update to the user who read the message
        try {
          await emitUnreadCountUpdate(message.chat_id, userId)
          
          // Also get all chat members and emit unread count updates to all of them
          // This ensures the chat list updates for all users when messages are read
          const { data: members } = await supabase
            .from('chat_members')
            .select('user_id')
            .eq('chat_id', message.chat_id)
          
          if (members) {
            for (const member of members) {
              if (member.user_id !== userId) {
                // Emit unread count update to other chat members as well
                await emitUnreadCountUpdate(message.chat_id, member.user_id)
              }
            }
          }
        } catch (error) {
          console.error('Failed to emit unread count update after read:', error)
        }
      } catch (error) {
        logger.error({ error, messageId, userId }, 'Failed to mark message as read')
      }
    })

    // Chat: active/inactive indicators for "currently viewing this chat" status
    socket.on('chat:active', ({ chatId }: { chatId: string }) => {
      resetTimeout()
      if (!chatId) return
      const room = `chat:${chatId}`
      bumpActive(io, room, 1)
    })

    socket.on('chat:inactive', ({ chatId }: { chatId: string }) => {
      resetTimeout()
      if (!chatId) return
      const room = `chat:${chatId}`
      bumpActive(io, room, -1)
    })

    // Friend Status: Get friend status
    socket.on('friend:status:get', async ({ userId: targetUserId }: { userId: string }) => {
      resetTimeout()
      const currentUserId: string | undefined = user?.id
      //console.log(`👤 Getting friend status between ${currentUserId} and ${targetUserId}`)
      
      if (!currentUserId || !targetUserId) {
        //console.log('❌ Missing currentUserId or targetUserId')
        socket.emit('friend:status:response', { error: 'Missing required parameters' })
        return
      }

      if (currentUserId === targetUserId) {
        socket.emit('friend:status:response', { status: 'self' })
        return
      }

      try {
        // Check friendships table for any status (active, pending, accepted)
        const { data: friendshipData, error: friendshipError } = await supabase
          .from('friendships')
          .select('*')
          .or(`and(user1_id.eq.${currentUserId},user2_id.eq.${targetUserId}),and(user1_id.eq.${targetUserId},user2_id.eq.${currentUserId})`)
          .in('status', ['active', 'accepted', 'pending'])
          .limit(1)
          .maybeSingle()

        if (friendshipError && friendshipError.code !== 'PGRST116' && friendshipError.code !== '42P01') {
          console.warn('Friendships table error:', friendshipError)
        }

        let status = 'none'
        
        if (friendshipData) {
          if (friendshipData.status === 'active' || friendshipData.status === 'accepted') {
            //console.log('✅ Users are friends')
            status = 'friends'
          } else if (friendshipData.status === 'pending') {
            // Check who sent the request
            if (friendshipData.sender_id === currentUserId) {
              // Current user sent the request
              //console.log('✅ Current user sent friend request')
              status = 'pending_sent'
            } else {
              // Current user received the request
              //console.log('✅ Current user received friend request')
              status = 'pending_received'
            }
          }
        }
        
        //console.log('✅ Friend status:', status)
        socket.emit('friend:status:response', { 
          status,
          requestId: friendshipData?.id // Include request ID for accept/decline
        })

      } catch (error) {
        console.error('❌ Error getting friend status:', error)
        socket.emit('friend:status:response', { error: 'Failed to get friend status' })
      }
    })

    // ========================================
    // FRIEND REQUEST HANDLERS
    // All friend request logic is now handled by friendRequestHandler.ts
    // Using simplified friendships table with status field
    // ========================================

    // Message Request: Cancel message request
    socket.on('message:request:cancel', async ({ receiverId }: { receiverId: string }) => {
      resetTimeout()
      const senderId: string | undefined = user?.id
      //console.log(`🚫 Cancelling message request from ${senderId} to ${receiverId}`)
      
      if (!senderId || !receiverId) {
        //console.log('❌ Missing senderId or receiverId for message cancel')
        socket.emit('message:request:error', { error: 'Missing required parameters' })
        return
      }

      try {
        // For message requests, we might need to cancel matchmaking proposals
        // or other pending message-related requests
        
        // Check if there's a pending matchmaking proposal
        const { data: proposals, error: proposalError } = await supabase
          .from('matchmaking_proposals')
          .select('*')
          .or(`and(a.eq.${senderId},b.eq.${receiverId}),and(a.eq.${receiverId},b.eq.${senderId})`)
          .eq('status', 'pending')

        if (proposalError) {
          console.error('❌ Error finding message proposals:', proposalError)
          socket.emit('message:request:error', { error: 'Failed to find message request' })
          return
        }

        if (proposals && proposals.length > 0) {
          // Cancel the matchmaking proposal
          const proposal = proposals[0]
          const { error: cancelError } = await supabase
            .from('matchmaking_proposals')
            .update({ status: 'cancelled' })
            .eq('id', proposal.id)

          if (cancelError) {
            console.error('❌ Error cancelling message proposal:', cancelError)
            socket.emit('message:request:error', { error: 'Failed to cancel message request' })
            return
          }

          //console.log(`✅ Message request cancelled`)

          // Notify receiver that message request was cancelled
          io.to(receiverId).emit('message:request:cancelled', {
            proposal,
            cancelledBy: senderId
          })

          // Confirm to sender
          socket.emit('message:request:cancel:confirmed', {
            proposal,
            success: true
          })
        } else {
          // No pending message request found
          socket.emit('message:request:error', { error: 'No pending message request found' })
        }

      } catch (error) {
        console.error('❌ Error cancelling message request:', error)
        socket.emit('message:request:error', { error: 'Failed to cancel message request' })
      }
    })

    // Notifications: Get current notifications
    socket.on('notifications:get', async () => {
      resetTimeout()
      const userId: string | undefined = user?.id
      //console.log(`📋 Getting notifications for user ${userId}`)
      
      if (!userId) {
        //console.log('❌ Missing userId for notifications')
        return
      }

      try {
        // Get pending friend requests for this user
        const { data: friendRequests, error } = await supabase
          .from('friend_requests')
          .select(`
            *,
            sender:profiles!sender_id(id, first_name, last_name, profile_photo_url)
          `)
          .eq('receiver_id', userId)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })

        if (error) {
          console.error('❌ Error fetching notifications:', error)
          return
        }

        //console.log(`✅ Found ${friendRequests?.length || 0} notifications for user ${userId}`)

        // Send notifications list to user
        socket.emit('notifications:list', {
          notifications: friendRequests || []
        })

      } catch (error) {
        console.error('❌ Error getting notifications:', error)
      }
    })

    // Chat: edit message (owner only) with rate limiting
    socket.on('chat:edit', async ({ messageId, text }: { messageId: string; text: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!userId || !messageId || !text?.trim()) return
      
      if (!(await checkEventRateLimit(userId, 'chat:edit'))) {
        logger.warn({ userId, socketId: socket.id }, 'Chat edit rate limit exceeded')
        return
      }
      
      try {
        const updatedMessage = await editMessage(messageId, userId, text.trim())
        const chatId = updatedMessage.chat_id
        io.to(`chat:${chatId}`).emit('chat:message:edited', { chatId, messageId, text: text.trim() })
      } catch (error) {
        logger.error({ error, userId, messageId }, 'Socket edit message error')
      }
    })

    // Chat: delete message (owner only) with rate limiting
    socket.on('chat:delete', async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId || !messageId) return
      
      if (!(await checkEventRateLimit(userId, 'chat:delete'))) {
        logger.warn({ userId, socketId: socket.id }, 'Chat delete rate limit exceeded')
        return
      }
      
      try {
        await deleteMessage(chatId, messageId, userId)
        io.to(`chat:${chatId}`).emit('chat:message:deleted', { chatId, messageId })
      } catch (error) {
        logger.error({ error, userId, chatId, messageId }, 'Socket delete message error')
      }
    })

    // Chat: Clear conversation (soft delete all messages)
    socket.on('chat:clear', async ({ chatId }: { chatId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      //console.log(`🗑️ Clearing chat ${chatId} for user ${userId}`)
      
      if (!userId || !chatId) {
        //console.log('❌ Missing userId or chatId for chat clear')
        socket.emit('chat:clear:error', { error: 'Missing required parameters' })
        return
      }

      // Rate limiting for chat clear
      if (!(await checkEventRateLimit(userId, 'chat:clear'))) {
        logger.warn({ userId, socketId: socket.id }, 'Chat clear rate limit exceeded')
        socket.emit('chat:clear:error', { error: 'Rate limit exceeded. Please wait before clearing again.' })
        return
      }

      try {
        // Check if this is a blind date chat (bypass membership check)
        const { BlindDatingService } = await import('../services/blind-dating.service.js')
        const isBlindDate = await BlindDatingService.isBlindDateChat(chatId)
        
        if (isBlindDate) {
          // For blind date chats, verify user is part of the match
          const { data: match } = await supabase
            .from('blind_date_matches')
            .select('user_a, user_b')
            .eq('chat_id', chatId)
            .in('status', ['active', 'revealed'])
            .maybeSingle()
          
          if (!match || (match.user_a !== userId && match.user_b !== userId)) {
            socket.emit('chat:clear:error', { error: 'Not authorized to clear this chat' })
            return
          }
          // User is part of the blind date match, allow deletion
        } else {
          // For regular chats, verify user is a member of this chat
          const { data: membership, error: memberError } = await supabase
            .from('chat_members')
            .select('id, user_id, chat_id')
            .eq('chat_id', chatId)
            .eq('user_id', userId)
            .single()

          if (memberError || !membership) {
            // Fallback: Check if user has sent messages in this chat
            const { data: userMessages } = await supabase
              .from('messages')
              .select('id')
              .eq('chat_id', chatId)
              .eq('sender_id', userId)
              .limit(1)
            
            if (!userMessages || userMessages.length === 0) {
              socket.emit('chat:clear:error', { error: 'Not authorized to clear this chat' })
              return
            }
          }
        }

        //console.log('✅ User is authorized to clear this chat')

        // Create user-specific chat deletion record instead of deleting messages for everyone
        // This allows the chat to be cleared for the user who initiated it, but remain visible for others
        
        // First, check if user already has a deletion record for this chat
        const { data: existingDeletion } = await supabase
          .from('chat_deletions')
          .select('id')
          .eq('chat_id', chatId)
          .eq('user_id', userId)
          .maybeSingle()

        if (existingDeletion) {
          // Update existing deletion record with new timestamp
          const { error: updateError } = await supabase
            .from('chat_deletions')
            .update({ 
              deleted_at: new Date().toISOString()
            })
            .eq('id', existingDeletion.id)

          if (updateError) {
            console.error('❌ Error updating chat deletion record:', updateError)
            socket.emit('chat:clear:error', { error: 'Failed to clear chat' })
            return
          }
        } else {
          // Create new deletion record for this user
          const { error: insertError } = await supabase
            .from('chat_deletions')
            .insert({
              chat_id: chatId,
              user_id: userId,
              deleted_at: new Date().toISOString()
            })

          if (insertError) {
            console.error('❌ Error creating chat deletion record:', insertError)
            socket.emit('chat:clear:error', { error: 'Failed to clear chat' })
            return
          }
        }

        //console.log(`✅ Chat ${chatId} cleared successfully for user ${userId} (user-specific deletion)`)

        // Notify only the user who cleared the chat
        socket.emit('chat:clear:success', { 
          chatId,
          message: 'Chat cleared successfully'
        })

        // Do NOT notify other users - the chat remains visible for them
        //console.log('ℹ️ Chat cleared only for requesting user, other users still see the chat')

      } catch (error) {
        console.error('❌ Error clearing chat:', error)
        socket.emit('chat:clear:error', { error: 'Failed to clear chat' })
      }
    })

    // Chat: join a chat room to receive events
    socket.on('chat:join', async ({ chatId }: { chatId: string }) => {
      resetTimeout()
      if (!chatId) return
      
      const userId: string | undefined = user?.id
      if (userId && !(await checkEventRateLimit(userId, 'chat:join'))) {
        logger.warn({ userId, socketId: socket.id }, 'Chat join rate limit exceeded')
        return
      }
      
      const room = `chat:${chatId}`
      try { 
        socket.join(room) 
      } catch (error) {
        logger.error({ error, chatId }, 'Failed to join chat room')
        return
      }
      
      // Send recent history (camelCase) with reactions and status - with error handling
      try {
        const rows = await getChatMessages(chatId, 30, undefined, userId)
        const msgs = rows.map(r => {
          // Determine message status based on receipts
          let status = 'sent' // Default status for sent messages
          if ((r as any).receipts && (r as any).receipts.length > 0) {
            // Check if any receipt has 'read' status
            const hasRead = (r as any).receipts.some((receipt: any) => receipt.status === 'read')
            if (hasRead) {
              status = 'read'
            } else {
              // Check if any receipt has 'delivered' status
              const hasDelivered = (r as any).receipts.some((receipt: any) => receipt.status === 'delivered')
              if (hasDelivered) {
                status = 'delivered'
              }
            }
          }

          return {
            id: r.id, 
            chatId: r.chat_id, 
            senderId: r.sender_id, 
            text: r.text,
            mediaUrl: r.media_url,
            mediaType: r.media_type,
            thumbnail: r.thumbnail,
            createdAt: new Date(r.created_at).getTime(),
            updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined,
            isEdited: r.is_edited || false,
            isDeleted: r.is_deleted || false,
            status: status, // Include the determined status
            reactions: (r as any).reactions?.map((reaction: any) => ({
              id: reaction.id,
              messageId: r.id,
              userId: reaction.user_id,
              emoji: reaction.emoji,
              createdAt: reaction.created_at
            })) || []
          }
        })
        socket.emit('chat:history', { chatId, messages: msgs })
      } catch (error) {
        logger.error({ error, chatId }, 'Failed to send chat history')
      }
      
      bumpRoom(io, room, 1)
    })

    // Chat: leave room
    socket.on('chat:leave', ({ chatId }: { chatId: string }) => {
      resetTimeout()
      if (!chatId) return
      const room = `chat:${chatId}`
      try { 
        socket.leave(room) 
      } catch (error) {
        logger.error({ error, chatId }, 'Failed to leave chat room')
      }
      bumpRoom(io, room, -1)
    })

    // Chat: typing indicator with rate limiting
    socket.on('chat:typing', async ({ chatId, typing }: { chatId: string; typing: boolean }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId) return
      
      if (!(await checkEventRateLimit(userId, 'chat:typing'))) {
        return // Silently ignore typing rate limits to avoid spam
      }
      
      setTyping(chatId, userId, !!typing)
      
      // Send to chat room (for users actively in the chat)
      socket.to(`chat:${chatId}`).emit('chat:typing', { chatId, users: getTyping(chatId) })
      
      // Also send to all chat members individually (for chat list updates)
      try {
        const { data: members } = await supabase
          .from('chat_members')
          .select('user_id')
          .eq('chat_id', chatId)
        
        if (members) {
          members.forEach((member: { user_id: string }) => {
            if (member.user_id !== userId) { // Don't send to sender
              io.to(member.user_id).emit('chat:typing', { chatId, users: getTyping(chatId) })
            }
          })
        }
      } catch (error) {
        logger.error({ error, chatId, userId }, 'Failed to send typing indicator to members')
      }
    })

    // Chat: send message with enhanced rate limiting and validation
    socket.on('chat:message', async ({ 
      chatId, 
      text, 
      mediaUrl, 
      mediaType, 
      thumbnail 
    }: { 
      chatId: string; 
      text: string;
      mediaUrl?: string;
      mediaType?: string;
      thumbnail?: string;
    }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      // Allow message if either text or media is provided
      if (!chatId || !userId || (!text?.trim() && !mediaUrl)) return
      
      // Stricter rate limiting for messages
      if (!(await checkEventRateLimit(userId, 'chat:message'))) {
        logger.warn({ userId, socketId: socket.id, chatId }, 'Chat message rate limit exceeded')
        socket.emit('chat:message:rate_limited', { error: 'Rate limit exceeded' })
        return
      }
      
      // Message length validation (only if text is provided)
      if (text && text.trim().length > 1000) {
        socket.emit('chat:message:error', { error: 'Message too long' })
        return
      }
      
      try {
        // Get chat members to check for blocks
        const { data: members } = await supabase
          .from('chat_members')
          .select('user_id')
          .eq('chat_id', chatId)
        
        if (!members || members.length !== 2) return // Only handle 1:1 chats for now
        
        const otherUserId = members.find(m => m.user_id !== userId)?.user_id
        if (!otherUserId) return
        
        // Check if either user has blocked the other
        const { data: blockCheck } = await supabase
          .from('blocks')
          .select('blocker_id, blocked_id')
          .or(`and(blocker_id.eq.${userId},blocked_id.eq.${otherUserId}),and(blocker_id.eq.${otherUserId},blocked_id.eq.${userId})`)
          .maybeSingle()
        
        if (blockCheck) {
          // Block detected - don't send the message
          socket.emit('chat:message:blocked', { 
            error: 'Message blocked',
            reason: blockCheck.blocker_id === userId ? 'user_blocked' : 'blocked_by_user'
          })
          return
        }

        // Check if this is a blind date chat (bypass friendship requirement)
        const { BlindDatingService } = await import('../services/blind-dating.service.js')
        const isBlindDate = await BlindDatingService.isBlindDateChat(chatId)
        
        // Only check friendship if it's NOT a blind date chat
        if (!isBlindDate) {
          const { data: friendshipCheck } = await supabase
            .from('friendships')
            .select('id')
            .or(`and(user1_id.eq.${userId},user2_id.eq.${otherUserId}),and(user1_id.eq.${otherUserId},user2_id.eq.${userId})`)
            .in('status', ['active', 'accepted'])
            .limit(1)
            .maybeSingle()
          
          if (!friendshipCheck) {
            // No friendship found - don't allow messaging
            socket.emit('chat:message:blocked', { 
              error: 'Messaging not allowed',
              reason: 'not_friends'
            })
            return
          }
        }
        
        // For blind date chats ONLY, filter messages for personal information
        // Regular chats and revealed blind dates bypass all filtering
        if (isBlindDate && text && text.trim()) {
          try {
            // Get the match for this chat using the service method
            const match = await BlindDatingService.getMatchByChatId(chatId)
            
            // Only filter if match exists AND identities are NOT revealed yet
            // Once revealed (status === 'revealed'), no filtering - users can share anything
            if (match && match.status !== 'revealed') {
              // Fast filtering with timeout to ensure real-time performance
              const filterPromise = BlindDatingService.filterMessage(
                text.trim(),
                match.id,
                userId
              )
              
              // Set a timeout for filtering (max 2 seconds to keep it real-time)
              const timeoutPromise = new Promise<{ allowed: false }>((resolve) => {
                setTimeout(() => resolve({ allowed: false }), 2000)
              })
              
              const filterResult = await Promise.race([filterPromise, timeoutPromise])
              
              if (!filterResult.allowed) {
                // Message contains personal information - block it
                socket.emit('chat:message:blocked', {
                  error: 'Message blocked',
                  reason: 'personal_info_detected',
                  message: 'Focus on conversation! Once your vibe matches, we will allow you to share personal information.',
                  blockedReason: (filterResult as any).blockedReason || 'Personal information detected'
                })
                return
              }
            }
            // If match is revealed or doesn't exist, proceed without filtering
          } catch (filterError) {
            logger.error({ error: filterError, chatId, userId }, 'Error filtering blind date message')
            // On error, allow the message but log it (fail open for real-time performance)
          }
        }
        // Regular chats (not blind date) bypass all filtering - proceed directly
        
        const row = await insertMessage(
          chatId, 
          userId, 
          text?.trim() || '', 
          mediaUrl, 
          mediaType, 
          thumbnail
        )
        const msg = { 
          id: row.id, 
          chatId: row.chat_id, 
          senderId: row.sender_id, 
          text: row.text,
          mediaUrl: row.media_url,
          mediaType: row.media_type,
          thumbnail: row.thumbnail,
          createdAt: new Date(row.created_at).getTime() 
        }
        
        // Send to chat room (for users actively in the chat)
        io.to(`chat:${chatId}`).emit('chat:message', { message: msg })
        
        // Mark message as sent for sender
        socket.emit('chat:message:sent', { messageId: msg.id, chatId })
        
        // Also send to all chat members individually (for background delivery)
        try {
          const { data: senderInfo, error: senderError } = await supabase
            .from('profiles')
            .select('first_name, last_name, username, email, profile_photo_url')
            .eq('id', userId)
            .single()
          
          if (senderError) {
            logger.error({ error: senderError, userId }, 'Error fetching sender info')
          }
          
          const senderName = senderInfo 
            ? (senderInfo.first_name && senderInfo.last_name 
                ? `${senderInfo.first_name} ${senderInfo.last_name}`.trim()
                : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
            : 'Someone'
          const senderAvatar = senderInfo?.profile_photo_url || null
          
          if (members) {
            // Process each member (parallel for better performance)
            const memberPromises = members.map(async (member: { user_id: string }) => {
              if (member.user_id !== userId) { // Don't send to sender
                try {
                  // Check if user is online (has active socket)
                  const userSockets = await io.fetchSockets()
                  const isOnline = userSockets.some((s: any) => {
                    const socketUser = (s.data as any)?.user
                    return socketUser?.id === member.user_id
                  })
                  
                  // Always send socket event if user has connection
                  if (isOnline) {
                    io.to(member.user_id).emit('chat:message:background', { 
                      message: { 
                        ...msg, 
                        senderName,
                        senderAvatar
                      } 
                    })
                  }
                  
                  // Always send push notification for messages
                  // (app may be backgrounded even with socket connected)
                  try {
                    const { PushNotificationService } = await import('../services/pushNotificationService.js')
                    await PushNotificationService.sendMessageNotification(
                      member.user_id,
                      senderName,
                      msg.text || 'New message',
                      chatId,
                      msg.id
                    )
                    logger.debug({ recipientId: member.user_id, chatId, isOnline }, 'Sent push notification for message')
                  } catch (pushError) {
                    logger.error({ error: pushError, recipientId: member.user_id }, 'Failed to send push notification')
                  }
                } catch (error) {
                  logger.error({ error, recipientId: member.user_id }, 'Error processing message delivery')
                }
              }
            })
            
            // Wait for all deliveries (don't block message sending)
            Promise.all(memberPromises).catch(err => {
              logger.error({ error: err, chatId }, 'Error in parallel message delivery')
            })
          }
        } catch (error) {
          logger.error({ error, chatId, userId }, 'Failed to send background message')
        }
      } catch (error) {
        logger.error({ error, chatId, userId }, 'Failed to send message')
        socket.emit('chat:message:error', { error: 'Failed to send message' })
      }
    })

    // Chat: delivery receipt with rate limiting
    socket.on('chat:delivered', async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId || !messageId) return
      
      if (!(await checkEventRateLimit(userId, 'chat:delivered'))) {
        return // Silently ignore receipt rate limits
      }
      
      try { 
        await insertReceipt(messageId, userId, 'delivered') 
      } catch (error) {
        logger.error({ error, messageId, userId }, 'Failed to insert delivery receipt')
      }
      socket.to(`chat:${chatId}`).emit('chat:delivered', { chatId, messageId, by: userId })
    })

    // Chat: read receipt with rate limiting
    socket.on('chat:read', async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId || !messageId) return
      
      if (!(await checkEventRateLimit(userId, 'chat:read'))) {
        return // Silently ignore receipt rate limits
      }
      
      try {
        await insertReceipt(messageId, userId, 'read')
        await insertReceipt(messageId, userId, 'delivered')
      } catch (error) {
        logger.error({ error, messageId, userId }, 'Failed to insert read receipt')
      }
      
      // Send to chat room
      io.to(`chat:${chatId}`).emit('chat:read', { chatId, messageId, by: userId })
      
      // Also send to all chat members individually (for chat list unread count updates)
      try {
        const { data: members } = await supabase
          .from('chat_members')
          .select('user_id')
          .eq('chat_id', chatId)
        
        if (members) {
          members.forEach((member: { user_id: string }) => {
            io.to(member.user_id).emit('chat:read', { chatId, messageId, by: userId })
          })
        }
      } catch (error) {
        logger.error({ error, chatId, messageId, userId }, 'Failed to send read receipt to members')
      }
    })

    // Chat: mark all messages as read
    socket.on('chat:mark-all-read', async ({ chatId }: { chatId: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId) return
      
      if (!(await checkEventRateLimit(userId, 'chat:mark-all-read'))) {
        return
      }
      
      try {
        // Ultra-efficient: Use a single SQL query to mark all messages as read
        // This avoids fetching messages first, then inserting receipts
        const { error: directInsertError } = await supabase.rpc('mark_chat_messages_read', {
          p_chat_id: chatId,
          p_user_id: userId
        })
        
        if (directInsertError) {
          //console.log('🔄 Direct SQL failed, using fallback batch method...')
          
          // Fallback: Get only unread messages to minimize operations
          const { data: unreadMessages, error: messagesError } = await supabase
            .from('messages')
            .select('id')
            .eq('chat_id', chatId)
            .not('id', 'in', `(
              SELECT message_id FROM message_receipts 
              WHERE user_id = '${userId}' AND status = 'read'
            )`)
            .order('created_at', { ascending: false })
            .limit(50) // Reduced limit for efficiency
          
          if (messagesError || !unreadMessages?.length) {
            socket.emit('chat:mark-all-read:confirmed', { chatId, success: true, markedCount: 0 })
            return
          }
          
          // Batch upsert only unread messages
          const receiptsToInsert = unreadMessages.map(msg => ({
            message_id: msg.id,
            user_id: userId,
            status: 'read' as const
          }))
          
          const { error: batchError } = await supabase
            .from('message_receipts')
            .upsert(receiptsToInsert, { onConflict: 'message_id,user_id,status' })
          
          if (batchError) {
            console.error('❌ Batch fallback failed:', batchError)
            socket.emit('chat:mark-all-read:confirmed', { chatId, success: false })
            return
          }
          
          //console.log(`✅ Fallback: Marked ${unreadMessages.length} unread messages`)
        } else {
          //console.log('✅ Direct SQL: All messages marked as read efficiently')
        }
        
        // Emit minimal events for real-time updates
        io.to(`chat:${chatId}`).emit('chat:all-read', { chatId, by: userId })
        socket.emit('chat:mark-all-read:confirmed', { chatId, success: true })
        
      } catch (error) {
        console.error('❌ Error in chat:mark-all-read:', error)
        socket.emit('chat:mark-all-read:confirmed', { chatId, success: false })
      }
    })

    // Chat: toggle reaction (WhatsApp style) with rate limiting
    socket.on('chat:reaction:toggle', async ({ chatId, messageId, emoji }: { chatId: string; messageId: string; emoji: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId || !messageId || !emoji) return
      
      if (!(await checkEventRateLimit(userId, 'chat:reaction'))) {
        logger.warn({ userId, socketId: socket.id }, 'Reaction rate limit exceeded')
        return
      }
      
      // Validate emoji (basic validation)
      if (emoji.length > 10) return
      
      try {
        const result = await toggleReaction(messageId, userId, emoji)
        if (result.action === 'added' && result.reaction) {
          const reactionData = {
            id: result.reaction.id,
            messageId: result.reaction.message_id,
            userId: result.reaction.user_id,
            emoji: result.reaction.emoji,
            createdAt: result.reaction.created_at
          }
          
          // Send to chat room
          io.to(`chat:${chatId}`).emit('chat:reaction:added', { chatId, messageId, reaction: reactionData })
          
          // Send to individual members with sender info for notifications
          try {
            const { data: members } = await supabase
              .from('chat_members')
              .select('user_id')
              .eq('chat_id', chatId)
            
            const { data: senderInfo, error: senderError } = await supabase
              .from('profiles')
              .select('first_name, last_name, username, email')
              .eq('id', userId)
              .single()
            
            const { data: messageInfo } = await supabase
              .from('messages')
              .select('text')
              .eq('id', messageId)
              .single()
            
            if (senderError) {
              logger.error({ error: senderError, userId }, 'Error fetching sender info for reaction')
            }
            
            const senderName = senderInfo 
              ? (senderInfo.first_name && senderInfo.last_name 
                  ? `${senderInfo.first_name} ${senderInfo.last_name}`.trim()
                  : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
              : 'Someone'
            
            if (members) {
              members.forEach((member: { user_id: string }) => {
                if (member.user_id !== userId) {
                  io.to(member.user_id).emit('chat:reaction:added', { 
                    chatId, 
                    messageId, 
                    reaction: { 
                      ...reactionData, 
                      senderName 
                    },
                    messageText: messageInfo?.text || 'a message'
                  })
                }
              })
            }
          } catch (error) {
            logger.error({ error, chatId, messageId, userId }, 'Failed to send reaction notification')
          }
        } else if (result.action === 'removed' && result.reaction) {
          io.to(`chat:${chatId}`).emit('chat:reaction:removed', { chatId, messageId, userId, emoji })
        }
      } catch (error) {
        logger.error({ error, chatId, messageId, userId, emoji }, 'Socket reaction toggle error')
      }
    })

    // Keep the old add reaction event for backward compatibility
    socket.on('chat:reaction:add', async ({ chatId, messageId, emoji }: { chatId: string; messageId: string; emoji: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId || !messageId || !emoji) return
      
      if (!(await checkEventRateLimit(userId, 'chat:reaction'))) {
        return
      }
      
      try {
        const reaction = await addReaction(messageId, userId, emoji)
        const reactionData = {
          id: reaction.id,
          messageId: reaction.message_id,
          userId: reaction.user_id,
          emoji: reaction.emoji,
          createdAt: reaction.created_at
        }
        io.to(`chat:${chatId}`).emit('chat:reaction:added', { chatId, messageId, reaction: reactionData })
      } catch (error) {
        logger.error({ error, chatId, messageId, userId, emoji }, 'Socket reaction add error')
      }
    })

    // Chat: remove reaction with rate limiting
    socket.on('chat:reaction:remove', async ({ chatId, messageId, emoji }: { chatId: string; messageId: string; emoji: string }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!chatId || !userId || !messageId || !emoji) return
      
      if (!(await checkEventRateLimit(userId, 'chat:reaction'))) {
        return
      }
      
      try {
        await removeReaction(messageId, userId, emoji)
        io.to(`chat:${chatId}`).emit('chat:reaction:removed', { chatId, messageId, userId, emoji })
      } catch (error) {
        logger.error({ error, chatId, messageId, userId, emoji }, 'Socket reaction remove error')
      }
    })

    // Profile Visit: Handle profile visit notifications
    socket.on('profile:visit', async ({ profileOwnerId, visitorId, visitorName }: { profileOwnerId: string, visitorId: string, visitorName: string }) => {
      resetTimeout()
      //console.log(`👁️ Profile visit: ${visitorName} (${visitorId}) visited ${profileOwnerId}'s profile`)
      
      if (!profileOwnerId || !visitorId || !visitorName) {
        //console.log('❌ Missing required parameters for profile visit')
        return
      }

      if (profileOwnerId === visitorId) {
        //console.log('❌ User cannot visit their own profile')
        return
      }

      try {
        // Create notification for profile owner
        await NotificationService.notifyProfileVisit(profileOwnerId, visitorId, visitorName)
        //console.log(`✅ Profile visit notification created for ${profileOwnerId}`)
        
        // Track profile visit activity for live feed
        const { data: visitor } = await supabase
          .from('profiles')
          .select('id, first_name, last_name')
          .eq('id', visitorId)
          .single()
        
        const { data: profileOwner } = await supabase
          .from('profiles')
          .select('id, first_name, last_name')
          .eq('id', profileOwnerId)
          .single()
        
        if (visitor && profileOwner) {
          await trackProfileVisited(visitor, profileOwner)
        }
      } catch (error) {
        console.error('❌ Error creating profile visit notification:', error)
      }
    })

    // Activity Feed: Get recent activities
    socket.on('activity:get_recent', async ({ limit }: { limit?: number }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      if (!userId) return
      
      if (!(await checkEventRateLimit(userId, 'activity:get_recent'))) {
        return
      }
      
      try {
        const activities = getRecentActivities(limit || 20)
        socket.emit('activity:recent_list', { activities })
        logger.info({ userId, count: activities.length }, 'Recent activities sent')
      } catch (error) {
        logger.error({ error, userId }, 'Failed to get recent activities')
        socket.emit('activity:recent_list', { activities: [] })
      }
    })

    // Voice call handlers are now handled by the dedicated VoiceCallHandler
    // Removed duplicate handlers to prevent conflicts

    // Set up voice call handlers
    if (userId) {
      setupVoiceCallHandlers(io, socket, userId);
      // Set up simplified friend request handlers
      setupFriendRequestHandlers(io, socket, userId);
      // Set up blind dating handlers
      setupBlindDatingHandlers(io, socket, userId);
      // Register test handlers for debugging
      registerTestHandlers(io, socket);
      
      // Periodic room verification to ensure user stays in their room
      const roomVerificationInterval = setInterval(() => {
        if (socket.connected && user?.id) {
          const isInRoom = socket.rooms.has(user.id);
          if (!isInRoom) {
            console.warn(`🔧 User ${user.id} not in room, rejoining...`);
            socket.join(user.id);
          }
        } else {
          clearInterval(roomVerificationInterval);
        }
      }, 30000); // Check every 30 seconds
      
      // Store interval for cleanup
      (socket.data as any).roomVerificationInterval = roomVerificationInterval;
      
      // Handle room membership verification requests from frontend
      socket.on('verify-room-membership', () => {
        if (user?.id) {
          const isInRoom = socket.rooms.has(user.id);
          
          
          if (!isInRoom) {
            //console.log(`🔧 Fixing room membership for ${user.id}`);
            socket.join(user.id);
          }
          
          // Send confirmation back to frontend
          socket.emit('room-membership-verified', {
            userId: user.id,
            isInRoom: socket.rooms.has(user.id),
            rooms: Array.from(socket.rooms)
          });
        }
      });
      
      // Handle connection state refresh for voice calls
      socket.on('refresh-connection-state', () => {
        if (user?.id) {
          //console.log(`🔄 Refreshing connection state for ${user.id}`);
          
          // Ensure user is in their room
          if (!socket.rooms.has(user.id)) {
            socket.join(user.id);
          }
          
          // Send connection state confirmation
          socket.emit('connection-state-refreshed', {
            userId: user.id,
            socketId: socket.id,
            isInRoom: socket.rooms.has(user.id),
            timestamp: Date.now()
          });
        }
      });
    }

    socket.on('disconnect', (reason) => {
      const user = (socket.data as any).user
      const userId = (socket.data as any).userId
      const timeout = (socket.data as any).timeout
      const roomVerificationInterval = (socket.data as any).roomVerificationInterval
      
      if (timeout) {
        clearTimeout(timeout)
      }
      
      if (roomVerificationInterval) {
        clearInterval(roomVerificationInterval)
      }
      
      untrackConnection(userId)
      
      // Clean up any stale matchmaking state for disconnected user
      if (userId) {
        // Import matchmaking service dynamically to avoid circular imports
        import('../services/matchmaking-optimized.js').then((module) => {
          if (module.cancelSearch) {
            module.cancelSearch(userId).catch(() => {
              // Ignore errors - user might not have been searching
            })
          }
        }).catch(() => {
          // Ignore import errors
        })
      }
      
      logger.info({ 
        id: socket.id,
        user,
        userId,
        reason
      }, 'socket disconnected')
    })
  })

  return io
}

// Export connection metrics for monitoring
export function getConnectionMetrics() {
  return {
    totalConnections,
    uniqueUsers: connectionCounts.size,
    averageConnectionsPerUser: connectionCounts.size > 0 ? totalConnections / connectionCounts.size : 0,
    maxConnectionsPerUser: MAX_CONNECTIONS_PER_USER,
    maxTotalConnections: MAX_TOTAL_CONNECTIONS
  }
}
