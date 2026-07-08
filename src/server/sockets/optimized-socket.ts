import { Server as IOServer } from 'socket.io'
import type { Server } from 'http'
import { createAdapter } from '@socket.io/redis-adapter'
import { logger } from '../config/logger.js'
import { verifyJwt } from '../utils/jwt.js'
import { setTyping, getTyping } from '../services/chat.js'
import { getChatMessages, insertMessage, insertReceipt, deleteMessage, editMessage, addReaction, toggleReaction, removeReaction, invalidateChatCaches, consumeViewOnceMessage } from '../repos/chat.repo.js'
import { and, desc, eq, gt, inArray, ne, notExists, notInArray, or, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import {
  blindDateMatches,
  blocks,
  chatDeletions,
  chatMembers,
  friendRequestsView,
  friendships,
  matchmakingProposals,
  messageReceipts,
  messages,
  profiles,
} from '../db/schema.js'
import { getStatus } from '../services/matchmaking-optimized.js'
import { NotificationService } from '../services/notificationService.js'
import { getRecentActivities, trackFriendRequestSent, trackFriendsConnected, trackProfileVisited } from '../services/activityService.js'
import { setupVoiceCallHandlers, registerTestHandlers } from '../handlers/voiceCallHandler.js'
import { setupFriendRequestHandlers } from '../handlers/friendRequestHandler.js'
import { setupBlindDatingHandlers } from '../handlers/blindDatingHandler.js'
import { setupPromptMatchingHandlers } from '../handlers/promptMatchingHandler.js'
import { Redis } from 'ioredis'

// Helper function to calculate and emit unread count for a specific chat
async function emitUnreadCountUpdate(chatId: string, userId: string) {
  try {
    // Messages from others in this chat that this user has no 'read' receipt for
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(
        eq(messages.chatId, chatId),
        eq(messages.isDeleted, false),
        ne(messages.senderId, userId),
        notExists(
          db.select({ one: sql`1` })
            .from(messageReceipts)
            .where(and(
              eq(messageReceipts.messageId, messages.id),
              eq(messageReceipts.userId, userId),
              eq(messageReceipts.status, 'read'),
            ))
        ),
      ))

    const unreadCount = row?.count ?? 0
    emitToUser(userId, 'chat:unread_count', { chatId, unreadCount })
  } catch (error) {
    console.error('Error calculating/emitting unread count:', error)
  }
}

// All member user-ids of a chat, straight from Postgres (no cache).
// Shared by handlers that fan events out to every member.
async function fetchChatMemberIds(chatId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
  return rows.map((r) => r.userId)
}

// When a user (re)connects, mark every message they received while offline as
// DELIVERED and notify each sender, so the sender's ticks upgrade from single
// (sent) to double-grey (delivered) the moment the recipient comes online —
// WhatsApp behaviour. Idempotent: messages already delivered/read are skipped.
async function flushPendingDeliveries(userId: string) {
  try {
    const memberships = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId))
    const chatIds = memberships.map(m => m.chatId)
    if (chatIds.length === 0) return

    // Recent messages from OTHERS across the user's chats.
    const msgs = await db
      .select({ id: messages.id, senderId: messages.senderId, chatId: messages.chatId })
      .from(messages)
      .where(and(
        inArray(messages.chatId, chatIds),
        ne(messages.senderId, userId),
        eq(messages.isDeleted, false),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(500)
    if (msgs.length === 0) return

    const msgIds = msgs.map(m => m.id)

    // Skip any that already have a delivered/read receipt by this user.
    const receipts = await db
      .select({ messageId: messageReceipts.messageId })
      .from(messageReceipts)
      .where(and(
        eq(messageReceipts.userId, userId),
        inArray(messageReceipts.status, ['delivered', 'read']),
        inArray(messageReceipts.messageId, msgIds),
      ))
    const alreadyDone = new Set(receipts.map(r => r.messageId))

    const pending = msgs.filter(m => !alreadyDone.has(m.id))
    if (pending.length === 0) return

    for (const m of pending) {
      try {
        await insertReceipt(m.id, userId, 'delivered')
        // chatId is required so the conversation screen's receipt handler
        // (which filters by chatId) actually applies the update.
        emitToUser(m.senderId, 'chat:message:delivery_receipt', {
          messageId: m.id,
          userId,
          status: 'delivered',
          chatId: m.chatId,
        })
      } catch (e) {
        logger.error({ error: e, messageId: m.id, userId }, 'Failed to flush delivery for message')
      }
    }
    logger.info({ userId, delivered: pending.length }, 'Flushed pending deliveries on connect')
  } catch (error) {
    logger.error({ error, userId }, 'flushPendingDeliveries failed')
  }
}

// Tell a user's chat partners that the user just came online / went offline.
// Presence is per-chat (`chat:presence` carries chatId) so each partner's open
// conversation can reflect it. "Online" = the user has >=1 live socket.
async function broadcastPresenceToPartners(userId: string, isOnline: boolean) {
  try {
    const memberships = await db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, userId))
    const chatIds = memberships.map(m => m.chatId)
    if (chatIds.length === 0) return

    const others = await db
      .select({ chatId: chatMembers.chatId, userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(inArray(chatMembers.chatId, chatIds), ne(chatMembers.userId, userId)))

    for (const o of others) {
      emitToUser(o.userId, 'chat:presence', {
        chatId: o.chatId,
        userId,           // who this presence is about
        isOnline,
        online: isOnline, // legacy field
      })
    }
  } catch (error) {
    logger.error({ error, userId }, 'Failed to broadcast presence to partners')
  }
}

// Redis client for connection management and rate limiting
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
})

// Connection limits and rate limiting constants - optimized for high traffic
const MAX_CONNECTIONS_PER_USER = 5          // Allow more devices per user
const MAX_TOTAL_CONNECTIONS = 50000         // Support more concurrent users
const RATE_LIMIT_WINDOW = 60                // seconds
const RATE_LIMIT_MAX_EVENTS = 300           // Higher limit for active users
const CONNECTION_TIMEOUT = 120000           // 2 minutes - more lenient for mobile

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

// Cache TTLs
const CHAT_MEMBERS_CACHE_TTL = 300 // 5 minutes
const BLOCK_STATUS_CACHE_TTL = 60 // 1 minute
const FRIENDSHIP_CACHE_TTL = 300 // 5 minutes

// Cached chat members lookup
async function getCachedChatMembers(chatId: string): Promise<string[] | null> {
  try {
    const cacheKey = `chat_members:${chatId}`
    const cached = await redis.get(cacheKey)
    if (cached) {
      return JSON.parse(cached)
    }
    
    const memberIds = await fetchChatMemberIds(chatId)
    if (memberIds.length > 0) {
      await redis.setex(cacheKey, CHAT_MEMBERS_CACHE_TTL, JSON.stringify(memberIds))
      return memberIds
    }
    return null
  } catch (error) {
    logger.error({ error, chatId }, 'Failed to get cached chat members')
    return null
  }
}

// Cached block status check
async function isBlocked(userId1: string, userId2: string): Promise<boolean> {
  try {
    const cacheKey = `block:${[userId1, userId2].sort().join(':')}`
    const cached = await redis.get(cacheKey)
    if (cached !== null) {
      return cached === '1'
    }
    
    const blockCheck = await db
      .select({ id: blocks.id })
      .from(blocks)
      .where(or(
        and(eq(blocks.blockerId, userId1), eq(blocks.blockedId, userId2)),
        and(eq(blocks.blockerId, userId2), eq(blocks.blockedId, userId1)),
      ))
      .limit(1)

    const blocked = blockCheck.length > 0
    await redis.setex(cacheKey, BLOCK_STATUS_CACHE_TTL, blocked ? '1' : '0')
    return blocked
  } catch (error) {
    logger.error({ error, userId1, userId2 }, 'Failed to check block status')
    return false // Fail open
  }
}

// Cached friendship check
async function areFriends(userId1: string, userId2: string): Promise<boolean> {
  try {
    const cacheKey = `friends:${[userId1, userId2].sort().join(':')}`
    const cached = await redis.get(cacheKey)
    if (cached !== null) {
      return cached === '1'
    }
    
    const friendship = await db
      .select({ id: friendships.id })
      .from(friendships)
      .where(and(
        or(
          and(eq(friendships.user1Id, userId1), eq(friendships.user2Id, userId2)),
          and(eq(friendships.user1Id, userId2), eq(friendships.user2Id, userId1)),
        ),
        inArray(friendships.status, ['active', 'accepted']),
      ))
      .limit(1)

    const friends = friendship.length > 0
    await redis.setex(cacheKey, FRIENDSHIP_CACHE_TTL, friends ? '1' : '0')
    return friends
  } catch (error) {
    logger.error({ error, userId1, userId2 }, 'Failed to check friendship')
    return false // Fail closed for security
  }
}

// Invalidate friendship cache when status changes
export function invalidateFriendshipCache(userId1: string, userId2: string) {
  const cacheKey = `friends:${[userId1, userId2].sort().join(':')}`
  redis.del(cacheKey).catch(err => logger.error({ error: err }, 'Failed to invalidate friendship cache'))
}

// Invalidate block cache when status changes
export function invalidateBlockCache(userId1: string, userId2: string) {
  const cacheKey = `block:${[userId1, userId2].sort().join(':')}`
  redis.del(cacheKey).catch(err => logger.error({ error: err }, 'Failed to invalidate block cache'))
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
    
    ioRef.to(userId).emit(event, payload)
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

export async function initOptimizedSocket(server: Server) {
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
    // Optimized for maximum real-time performance
    pingTimeout: 30000,        // Faster detection of dead connections
    pingInterval: 15000,       // More frequent pings for reliability
    upgradeTimeout: 5000,      // Faster upgrade timeout
    maxHttpBufferSize: 2e6,    // 2MB for media messages
    // WebSocket first for lowest latency
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    // Performance optimizations
    serveClient: false,
    httpCompression: true,
    perMessageDeflate: {
      threshold: 1024,         // Only compress messages > 1KB
      zlibDeflateOptions: { level: 1 }, // Fast compression
      zlibInflateOptions: { chunkSize: 16 * 1024 },
    },
    // Connection state recovery for seamless reconnects
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
      skipMiddlewares: true,
    },
  })
  
  ioRef = io
  
  // Setup Redis adapter for horizontal scaling (multiple Socket.IO instances)
  // CRITICAL: Always enable in production for blue-green deployment to work correctly
  const isProduction = process.env.NODE_ENV === 'production'
  const shouldUseRedisAdapter = isProduction || process.env.SOCKET_REDIS_ENABLED === 'true'
  
  if (shouldUseRedisAdapter) {
    try {
      const pubClient = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 100, 3000),
        enableReadyCheck: true,
        lazyConnect: false, // Connect immediately
      })
      const subClient = pubClient.duplicate()
      
      // Wait for both clients to be ready
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          pubClient.on('ready', () => resolve())
          pubClient.on('error', (err) => {
            logger.error({ error: err }, 'Redis pub client error')
          })
          setTimeout(() => reject(new Error('Redis pub client timeout')), 5000)
        }),
        new Promise<void>((resolve, reject) => {
          subClient.on('ready', () => resolve())
          subClient.on('error', (err) => {
            logger.error({ error: err }, 'Redis sub client error')
          })
          setTimeout(() => reject(new Error('Redis sub client timeout')), 5000)
        })
      ])
      
      io.adapter(createAdapter(pubClient, subClient))
      logger.info('✅ Socket.IO Redis adapter enabled for horizontal scaling (blue-green deployment)')
    } catch (error) {
      logger.error({ error }, '❌ Failed to setup Redis adapter for Socket.IO - messages may not sync across instances!')
    }
  } else {
    logger.warn('⚠️ Socket.IO Redis adapter NOT enabled - multi-instance messaging will NOT work!')
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
    // NOTE: presence is no longer derived from room socket counts (that counted
    // your own socket and stale memberships, so it showed "online" whenever you
    // had the chat open). Real presence is broadcast per-user on connect/
    // disconnect via broadcastPresenceToPartners and answered on chat:join.
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

  // Whether `userId` currently has this specific chat screen open on ANY of
  // their connected devices (tracked per-socket via chat:active/chat:inactive
  // — see those handlers below). activeCounts is a per-room aggregate that
  // can't tell the two participants apart (the sender's own socket keeps a
  // 1-on-1 chat's count >= 1 while they're mid-conversation), so push-
  // notification gating needs to check the RECIPIENT's own sockets directly.
  function isUserActiveInChat(io: IOServer, userId: string, chatId: string): boolean {
    const room = io.sockets.adapter.rooms.get(userId)
    if (!room) return false
    for (const socketId of room) {
      const sock = io.sockets.sockets.get(socketId)
      const activeChats = (sock?.data as any)?.activeChats
      if (activeChats instanceof Set && activeChats.has(chatId)) {
        return true
      }
    }
    return false
  }

  // Push notification body text lives in pushNotificationService
  // (describeMessageForNotification) so the socket path and the REST chat
  // route describe media/meme/view-once messages identically.

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

        // Mark messages received while offline as delivered and notify senders
        // so their ticks upgrade sent -> delivered immediately on (re)connect.
        flushPendingDeliveries(user.id).catch(err =>
          logger.error({ error: err, userId: user.id }, 'Failed to flush pending deliveries on connect')
        )

        // Announce online presence to chat partners on the user's FIRST live
        // connection (connectionCounts was already incremented in auth mw).
        if ((connectionCounts.get(user.id) || 0) === 1) {
          broadcastPresenceToPartners(user.id, true).catch(() => {})
        }
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
        const [message] = await db
          .select({ chatId: messages.chatId, senderId: messages.senderId })
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1)

        if (!message) {
          return
        }

        // Don't mark own messages as delivered
        if (message.senderId === userId) {
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

        //console.log(`✅ Delivery receipt added, notifying sender ${message.senderId}`)

        // Notify sender
        io.to(message.senderId).emit('chat:message:delivery_receipt', {
          messageId,
          userId,
          status: 'delivered',
          chatId: message.chatId
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
        const memberIds = await fetchChatMemberIds(chatId)
        for (const memberId of memberIds) {
          if (memberId !== currentUserId) {
            emitToUser(memberId, 'chat:list:typing', {
              chatId,
              by: currentUserId,
              isTyping: !!isTyping,
            })
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
        const [message] = await db
          .select({ chatId: messages.chatId, senderId: messages.senderId })
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1)

        if (!message) {
          return
        }

        // Don't mark own messages as read
        if (message.senderId === userId) {
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

        //console.log(`✅ Read receipt added, notifying sender ${message.senderId}`)

        // Notify sender
        io.to(message.senderId).emit('chat:message:read_receipt', {
          messageId,
          userId,
          status: 'read',
          chatId: message.chatId
        })

        // Also emit to chat room for real-time updates
        io.to(`chat:${message.chatId}`).emit('chat:read', {
          chatId: message.chatId,
          messageId,
          by: userId
        })

        // Emit unread count update to the user who read the message
        try {
          await emitUnreadCountUpdate(message.chatId, userId)

          // Also get all chat members and emit unread count updates to all of them
          // This ensures the chat list updates for all users when messages are read
          const memberIds = await fetchChatMemberIds(message.chatId)
          for (const memberId of memberIds) {
            if (memberId !== userId) {
              // Emit unread count update to other chat members as well
              await emitUnreadCountUpdate(message.chatId, memberId)
            }
          }
        } catch (error) {
          console.error('Failed to emit unread count update after read:', error)
        }
      } catch (error) {
        logger.error({ error, messageId, userId }, 'Failed to mark message as read')
      }
    })

    // Consume a view-once message: the ONLY path that ever hands out the real
    // media URL. Atomic (consumeViewOnceMessage guards on view_once_viewed_at
    // IS NULL), restricted to the recipient (not the sender — the sender
    // already has the original file on their own device, and letting them
    // "view" it here would risk burning the recipient's one-and-only view),
    // and best-effort deletes the S3 object afterward so a captured URL can't
    // be reused even out-of-band.
    socket.on('chat:message:viewed', async (
      { chatId, messageId }: { chatId: string; messageId: string },
      callback?: (response: { error?: string; mediaUrl?: string; mediaType?: string }) => void
    ) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      const respond = typeof callback === 'function' ? callback : () => {}

      if (!userId || !chatId || !messageId) {
        respond({ error: 'invalid_request' })
        return
      }

      try {
        const result = await consumeViewOnceMessage(messageId, chatId, userId)
        if (!result.ok) {
          respond({ error: result.reason })
          return
        }
        if (!result.mediaUrl) {
          respond({ error: 'not_found' })
          return
        }

        respond({ mediaUrl: result.mediaUrl, mediaType: result.mediaType || undefined })

        // Let the sender's other devices know it's been opened (e.g. to flip
        // their own bubble to "Opened"), without ever sending them the URL.
        io.to(result.senderId).emit('chat:message:view_once_consumed', { chatId, messageId })

        // Delete the S3 object so the URL eventually 404s even if captured —
        // but NOT immediately. The real one-time-view guarantee is already
        // the atomic view_once_viewed_at update above (no one can ever be
        // handed this URL again); this deletion is defense-in-depth on top
        // of that. Deleting it right away raced the client's own image
        // fetch: the ack still has to cross the network, trigger a
        // re-render, mount the image component, and THEN start its own HTTP
        // request for the bytes — which reliably lost the race against this
        // single S3 API call, so the recipient saw a blank/404'd image every
        // time. A short grace period gives that fetch time to complete.
        const mediaUrl = result.mediaUrl
        setTimeout(() => {
          void (async () => {
            try {
              const keyIndex = mediaUrl.indexOf('chat-media/')
              if (keyIndex !== -1) {
                const { S3Service } = await import('../../services/s3Service.js')
                await S3Service.deleteFile(mediaUrl.slice(keyIndex))
              }
            } catch (deleteError) {
              logger.error({ error: deleteError, messageId }, 'Failed to delete view-once media from S3')
            }
          })()
        }, 60_000)
      } catch (error) {
        logger.error({ error, messageId, userId }, 'Failed to consume view-once message')
        respond({ error: 'server_error' })
      }
    })

    // Chat: active/inactive indicators for "currently viewing this chat" status
    socket.on('chat:active', ({ chatId }: { chatId: string }) => {
      resetTimeout()
      if (!chatId) return
      const room = `chat:${chatId}`
      bumpActive(io, room, 1)

      // Track active chats per socket so push service can avoid notifying
      // when the user is already inside a specific conversation
      try {
        const data: any = socket.data || {}
        if (!data.activeChats) {
          data.activeChats = new Set<string>()
        }
        data.activeChats.add(chatId)
        socket.data = data
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to track active chat on socket')
      }
    })

    socket.on('chat:inactive', ({ chatId }: { chatId: string }) => {
      resetTimeout()
      if (!chatId) return
      const room = `chat:${chatId}`
      bumpActive(io, room, -1)

      try {
        const data: any = socket.data || {}
        if (data.activeChats && data.activeChats instanceof Set) {
          data.activeChats.delete(chatId)
        }
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to untrack active chat on socket')
      }
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
        const [friendshipData] = await db
          .select({ id: friendships.id, status: friendships.status, senderId: friendships.senderId })
          .from(friendships)
          .where(and(
            or(
              and(eq(friendships.user1Id, currentUserId), eq(friendships.user2Id, targetUserId)),
              and(eq(friendships.user1Id, targetUserId), eq(friendships.user2Id, currentUserId)),
            ),
            inArray(friendships.status, ['active', 'accepted', 'pending']),
          ))
          .limit(1)

        let status = 'none'

        if (friendshipData) {
          if (friendshipData.status === 'active' || friendshipData.status === 'accepted') {
            //console.log('✅ Users are friends')
            status = 'friends'
          } else if (friendshipData.status === 'pending') {
            // Check who sent the request
            if (friendshipData.senderId === currentUserId) {
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
        const proposals = await db
          .select()
          .from(matchmakingProposals)
          .where(and(
            or(
              and(eq(matchmakingProposals.a, senderId), eq(matchmakingProposals.b, receiverId)),
              and(eq(matchmakingProposals.a, receiverId), eq(matchmakingProposals.b, senderId)),
            ),
            eq(matchmakingProposals.status, 'pending'),
          ))

        if (proposals.length > 0) {
          // Cancel the matchmaking proposal
          const proposal = proposals[0]
          await db
            .update(matchmakingProposals)
            .set({ status: 'cancelled' })
            .where(eq(matchmakingProposals.id, proposal.id))

          //console.log(`✅ Message request cancelled`)

          // Payload shape matches the old raw supabase row (snake_case)
          const proposalPayload = {
            id: proposal.id,
            a: proposal.a,
            b: proposal.b,
            status: 'cancelled',
            type: proposal.type,
            matched_at: proposal.matchedAt,
            created_at: proposal.createdAt,
            action_source: proposal.actionSource,
          }

          // Notify receiver that message request was cancelled
          io.to(receiverId).emit('message:request:cancelled', {
            proposal: proposalPayload,
            cancelledBy: senderId
          })

          // Confirm to sender
          socket.emit('message:request:cancel:confirmed', {
            proposal: proposalPayload,
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
        // Get pending friend requests for this user.
        // friend_requests is a VIEW (friend_requests_view) over friendships
        // where status = 'pending'; join profiles for the sender card.
        const rows = await db
          .select({
            id: friendRequestsView.id,
            senderId: friendRequestsView.senderId,
            receiverId: friendRequestsView.receiverId,
            status: friendRequestsView.status,
            createdAt: friendRequestsView.createdAt,
            updatedAt: friendRequestsView.updatedAt,
            senderProfileId: profiles.id,
            senderFirstName: profiles.firstName,
            senderLastName: profiles.lastName,
            senderProfilePhotoUrl: profiles.profilePhotoUrl,
          })
          .from(friendRequestsView)
          .leftJoin(profiles, eq(profiles.id, friendRequestsView.senderId))
          .where(and(eq(friendRequestsView.receiverId, userId), eq(friendRequestsView.status, 'pending')))
          .orderBy(desc(friendRequestsView.createdAt))

        const notifications = rows.map(r => ({
          id: r.id,
          sender_id: r.senderId,
          receiver_id: r.receiverId,
          status: r.status,
          created_at: r.createdAt,
          updated_at: r.updatedAt,
          sender: r.senderProfileId ? {
            id: r.senderProfileId,
            first_name: r.senderFirstName,
            last_name: r.senderLastName,
            profile_photo_url: r.senderProfilePhotoUrl,
          } : null,
        }))

        //console.log(`✅ Found ${notifications.length} notifications for user ${userId}`)

        // Send notifications list to user
        socket.emit('notifications:list', { notifications })

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
          const [match] = await db
            .select({ userA: blindDateMatches.userA, userB: blindDateMatches.userB })
            .from(blindDateMatches)
            .where(and(
              eq(blindDateMatches.chatId, chatId),
              inArray(blindDateMatches.status, ['active', 'revealed']),
            ))
            .limit(1)

          if (!match || (match.userA !== userId && match.userB !== userId)) {
            socket.emit('chat:clear:error', { error: 'Not authorized to clear this chat' })
            return
          }
          // User is part of the blind date match, allow deletion
        } else {
          // For regular chats, verify user is a member of this chat
          const [membership] = await db
            .select({ userId: chatMembers.userId })
            .from(chatMembers)
            .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
            .limit(1)

          if (!membership) {
            // Fallback: Check if user has sent messages in this chat
            const userMessages = await db
              .select({ id: messages.id })
              .from(messages)
              .where(and(eq(messages.chatId, chatId), eq(messages.senderId, userId)))
              .limit(1)

            if (userMessages.length === 0) {
              socket.emit('chat:clear:error', { error: 'Not authorized to clear this chat' })
              return
            }
          }
        }

        //console.log('✅ User is authorized to clear this chat')

        // Create user-specific chat deletion record instead of deleting messages for everyone
        // This allows the chat to be cleared for the user who initiated it, but remain visible for others
        // (chat_deletions has unique(chat_id, user_id) — single upsert)
        await db
          .insert(chatDeletions)
          .values({ chatId, userId, deletedAt: new Date().toISOString() })
          .onConflictDoUpdate({
            target: [chatDeletions.chatId, chatDeletions.userId],
            set: { deletedAt: new Date().toISOString() },
          })

        //console.log(`✅ Chat ${chatId} cleared successfully for user ${userId} (user-specific deletion)`)

        // Clearing changes this user's inbox and message history — drop caches.
        await invalidateChatCaches(chatId)

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
            mediaUrl: r.media_url, // already stripped by getChatMessages for view-once
            mediaType: r.media_type,
            thumbnail: r.thumbnail,
            sharedMemeId: (r as any).shared_meme_id,
            isViewOnce: (r as any).is_view_once || false,
            viewOnceViewed: !!(r as any).view_once_viewed_at,
            reply_to_id: r.reply_to_id, // Include reply reference
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

      // Tell the opener whether the OTHER member is currently online, so the
      // header shows the correct status immediately on open (not just after the
      // other user next connects/disconnects).
      try {
        const members = await getCachedChatMembers(chatId)
        const otherId = (members || []).find(id => id !== userId)
        if (otherId) {
          const otherOnline = (connectionCounts.get(otherId) || 0) > 0
          socket.emit('chat:presence', {
            chatId,
            userId: otherId,
            isOnline: otherOnline,
            online: otherOnline,
          })
        }
      } catch (presenceError) {
        logger.error({ error: presenceError, chatId }, 'Failed to send initial presence on join')
      }
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
        const memberIds = await fetchChatMemberIds(chatId)
        for (const memberId of memberIds) {
          if (memberId !== userId) { // Don't send to sender
            io.to(memberId).emit('chat:typing', { chatId, users: getTyping(chatId) })
          }
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
      thumbnail,
      replyToId,
      tempId,
      isViewOnce
    }: {
      chatId: string;
      text: string;
      mediaUrl?: string;
      mediaType?: string;
      thumbnail?: string;
      replyToId?: string;
      tempId?: string;
      isViewOnce?: boolean;
    }) => {
      resetTimeout()
      const userId: string | undefined = user?.id
      // Don't silently drop. A missing userId means the socket connected without
      // a valid token — tell the client so it can prompt a re-login instead of
      // the message just vanishing.
      if (!userId) {
        socket.emit('chat:message:error', { error: 'Your session has expired. Please sign in again.', reason: 'unauthenticated' })
        return
      }
      if (!chatId || (!text?.trim() && !mediaUrl)) {
        socket.emit('chat:message:error', { error: 'Message could not be sent.', reason: 'invalid_request' })
        return
      }
      
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
        // Get chat members using cache for faster lookup
        const memberIds = await getCachedChatMembers(chatId)

        if (!memberIds || memberIds.length !== 2) {
          socket.emit('chat:message:error', { error: 'This conversation is unavailable.', reason: 'invalid_chat' })
          return // Only handle 1:1 chats for now
        }

        const otherUserId = memberIds.find(id => id !== userId)
        if (!otherUserId) {
          socket.emit('chat:message:error', { error: 'This conversation is unavailable.', reason: 'invalid_chat' })
          return
        }
        
        // Check if either user has blocked the other (cached)
        const blocked = await isBlocked(userId, otherUserId)
        
        if (blocked) {
          // Block detected - don't send the message
          socket.emit('chat:message:blocked', { 
            error: 'Message blocked',
            reason: 'blocked'
          })
          return
        }

        // Check if this is a blind date chat (bypass friendship requirement)
        const { BlindDatingService } = await import('../services/blind-dating.service.js')
        const isBlindDate = await BlindDatingService.isBlindDateChat(chatId)
        
        // Only check friendship if it's NOT a blind date chat (cached)
        if (!isBlindDate) {
          const friends = await areFriends(userId, otherUserId)
          
          if (!friends) {
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
          thumbnail,
          replyToId,
          isViewOnce
        )
        const msg = {
          id: row.id,
          chatId: row.chat_id,
          senderId: row.sender_id,
          text: row.text,
          mediaUrl: row.media_url, // already stripped by insertMessage for view-once
          mediaType: row.media_type,
          thumbnail: row.thumbnail,
          isViewOnce: row.is_view_once || false,
          reply_to_id: row.reply_to_id,
          createdAt: new Date(row.created_at).getTime(),
          tempId // Include tempId for optimistic update matching
        }
        
        // Send to chat room (for users actively in the chat)
        io.to(`chat:${chatId}`).emit('chat:message', { message: msg })
        
        // Mark message as sent for sender
        socket.emit('chat:message:sent', { messageId: msg.id, chatId })
        
        // Also send to all chat members individually (for background delivery)
        try {
          let senderInfo:
            | { firstName: string | null; lastName: string | null; username: string | null; email: string | null; profilePhotoUrl: string | null }
            | undefined
          try {
            const rows = await db
              .select({
                firstName: profiles.firstName,
                lastName: profiles.lastName,
                username: profiles.username,
                email: profiles.email,
                profilePhotoUrl: profiles.profilePhotoUrl,
              })
              .from(profiles)
              .where(eq(profiles.id, userId))
              .limit(1)
            senderInfo = rows[0]
          } catch (senderError) {
            logger.error({ error: senderError, userId }, 'Error fetching sender info')
          }

          // Check if this is a blind date chat (active, not revealed)
          const [blindMatch] = await db
            .select({ id: blindDateMatches.id })
            .from(blindDateMatches)
            .where(and(eq(blindDateMatches.chatId, chatId), eq(blindDateMatches.status, 'active')))
            .limit(1)

          const isBlindDateChat = !!blindMatch
          
          // Helper function to mask name for blind date
          const maskName = (firstName: string | null, lastName: string | null): string => {
            const maskWord = (word: string) => {
              if (!word || word.length === 0) return ''
              if (word.length === 1) return word[0] + '*'
              return word[0] + '*'.repeat(word.length - 1)
            }
            
            if (!firstName) return 'Anonymous'
            const maskedFirst = maskWord(firstName.trim())
            const maskedLast = lastName?.trim() ? maskWord(lastName.trim()) : ''
            return maskedLast ? `${maskedFirst} ${maskedLast}` : maskedFirst
          }
          
          // Use masked name for blind date chats, real name otherwise
          const realName = senderInfo
            ? (senderInfo.firstName && senderInfo.lastName
                ? `${senderInfo.firstName} ${senderInfo.lastName}`.trim()
                : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
            : 'Someone'

          const senderName = isBlindDateChat
            ? maskName(senderInfo?.firstName || null, senderInfo?.lastName || null)
            : realName

          const senderAvatar = senderInfo?.profilePhotoUrl || null
          
          if (memberIds && memberIds.length > 0) {
            // Process each member (parallel for better performance)
            const memberPromises = memberIds.map(async (memberId: string) => {
              if (memberId !== userId) { // Don't send to sender
                try {
                  // Always send socket event to user's personal room
                  // This ensures chat list updates in real-time
                  io.to(memberId).emit('chat:message:background', {
                    message: {
                      ...msg,
                      senderName,
                      senderAvatar,
                      isBlindDateChat
                    }
                  })

                  // Server-authoritative DELIVERED: if the recipient has a live
                  // socket connection, the message has reached their device.
                  // Record the receipt and tell the sender so the tick goes from
                  // single (sent) to double-grey (delivered) without relying on
                  // the client to round-trip a delivery event.
                  if ((connectionCounts.get(memberId) || 0) > 0) {
                    try {
                      await insertReceipt(msg.id, memberId, 'delivered')
                      io.to(userId).emit('chat:message:delivery_receipt', {
                        messageId: msg.id,
                        userId: memberId,
                        status: 'delivered',
                        chatId,
                      })
                    } catch (deliveryError) {
                      logger.error({ error: deliveryError, messageId: msg.id, memberId }, 'Failed to auto-mark delivered')
                    }
                  }

                  // Keep the recipient's unread badge accurate from a single
                  // source of truth (the server), so chat-list counts don't drift.
                  emitUnreadCountUpdate(chatId, memberId).catch((unreadError) => {
                    logger.error({ error: unreadError, chatId, memberId }, 'Failed to emit unread count on new message')
                  })

                  // Send push notification asynchronously (don't await to avoid blocking)
                  // — but only if the recipient doesn't already have this chat
                  // open on some device; otherwise they'd get a redundant push
                  // for a message they're already looking at in real time.
                  if (!isUserActiveInChat(io, memberId, chatId)) {
                    import('../services/pushNotificationService.js').then(({ PushNotificationService, describeMessageForNotification }) => {
                      PushNotificationService.sendMessageNotification(
                        memberId,
                        senderName, // Already masked for blind date
                        describeMessageForNotification(msg),
                        chatId,
                        msg.id
                      ).catch(pushError => {
                        logger.error({ error: pushError, recipientId: memberId }, 'Failed to send push notification')
                      })
                    }).catch(err => {
                      logger.error({ error: err }, 'Failed to import push notification service')
                    })
                  }
                } catch (error) {
                  logger.error({ error, recipientId: memberId }, 'Error processing message delivery')
                }
              }
            })
            
            // Don't await - let deliveries happen in background
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
        const memberIds = await fetchChatMemberIds(chatId)
        for (const memberId of memberIds) {
          io.to(memberId).emit('chat:read', { chatId, messageId, by: userId })
        }

        // Emit updated unread count to the user who read the message
        await emitUnreadCountUpdate(chatId, userId)
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
        // Ultra-efficient: one SQL call marks the whole chat read.
        // mark_chat_messages_read(p_chat_id uuid, p_user_id uuid) returns integer
        // exists in the database (verified in pg_proc).
        let rpcFailed = false
        try {
          await db.execute(sql`select mark_chat_messages_read(${chatId}::uuid, ${userId}::uuid)`)
        } catch (rpcError) {
          logger.warn({ error: rpcError, chatId, userId }, 'mark_chat_messages_read failed, using fallback')
          rpcFailed = true
        }

        if (rpcFailed) {
          // Fallback: mark only unread messages, batched
          const unreadMessages = await db
            .select({ id: messages.id })
            .from(messages)
            .where(and(
              eq(messages.chatId, chatId),
              notInArray(
                messages.id,
                db.select({ messageId: messageReceipts.messageId })
                  .from(messageReceipts)
                  .where(and(eq(messageReceipts.userId, userId), eq(messageReceipts.status, 'read')))
              ),
            ))
            .orderBy(desc(messages.createdAt))
            .limit(50)

          if (!unreadMessages.length) {
            socket.emit('chat:mark-all-read:confirmed', { chatId, success: true, markedCount: 0 })
            return
          }

          await db
            .insert(messageReceipts)
            .values(unreadMessages.map(msg => ({
              messageId: msg.id,
              userId,
              status: 'read' as const,
            })))
            .onConflictDoNothing({
              target: [messageReceipts.messageId, messageReceipts.userId, messageReceipts.status],
            })
        }

        // Unread count for this user changed — drop their inbox cache so the
        // chat list reflects zero unread immediately.
        await invalidateChatCaches(chatId)

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
            const memberIds = await fetchChatMemberIds(chatId)

            let senderInfo:
              | { firstName: string | null; lastName: string | null; username: string | null; email: string | null }
              | undefined
            try {
              const rows = await db
                .select({
                  firstName: profiles.firstName,
                  lastName: profiles.lastName,
                  username: profiles.username,
                  email: profiles.email,
                })
                .from(profiles)
                .where(eq(profiles.id, userId))
                .limit(1)
              senderInfo = rows[0]
            } catch (senderError) {
              logger.error({ error: senderError, userId }, 'Error fetching sender info for reaction')
            }

            const [messageInfo] = await db
              .select({ text: messages.text })
              .from(messages)
              .where(eq(messages.id, messageId))
              .limit(1)

            const senderName = senderInfo
              ? (senderInfo.firstName && senderInfo.lastName
                  ? `${senderInfo.firstName} ${senderInfo.lastName}`.trim()
                  : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
              : 'Someone'

            for (const memberId of memberIds) {
              if (memberId !== userId) {
                io.to(memberId).emit('chat:reaction:added', {
                  chatId,
                  messageId,
                  reaction: {
                    ...reactionData,
                    senderName
                  },
                  messageText: messageInfo?.text || 'a message'
                })
              }
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
        const [visitorRow] = await db
          .select({
            id: profiles.id,
            firstName: profiles.firstName,
            lastName: profiles.lastName,
            profilePhotoUrl: profiles.profilePhotoUrl,
            invisibleMode: profiles.invisibleMode,
          })
          .from(profiles)
          .where(eq(profiles.id, visitorId))
          .limit(1)

        const [ownerRow] = await db
          .select({
            id: profiles.id,
            firstName: profiles.firstName,
            lastName: profiles.lastName,
            profilePhotoUrl: profiles.profilePhotoUrl,
            invisibleMode: profiles.invisibleMode,
          })
          .from(profiles)
          .where(eq(profiles.id, profileOwnerId))
          .limit(1)

        if (visitorRow && ownerRow) {
          await trackProfileVisited(
            {
              id: visitorRow.id,
              first_name: visitorRow.firstName,
              last_name: visitorRow.lastName,
              profile_photo_url: visitorRow.profilePhotoUrl,
              invisible_mode: visitorRow.invisibleMode,
            },
            {
              id: ownerRow.id,
              first_name: ownerRow.firstName,
              last_name: ownerRow.lastName,
              profile_photo_url: ownerRow.profilePhotoUrl,
              invisible_mode: ownerRow.invisibleMode,
            },
          )
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
      // Set up prompt matching handlers
      setupPromptMatchingHandlers(io, socket, userId);
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

      // If this was the user's LAST live connection, tell chat partners they're
      // offline. (untrackConnection already decremented/removed the count.)
      if (userId && (connectionCounts.get(userId) || 0) === 0) {
        broadcastPresenceToPartners(userId, false).catch(() => {})
      }

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
