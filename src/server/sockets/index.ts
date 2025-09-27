import { Server as IOServer } from 'socket.io'
import type { Server } from 'http'
import { logger } from '../config/logger.js'
import { verifyJwt } from '../utils/jwt.js'
import { setTyping, getTyping } from '../services/chat.js'
import { getChatMessages, insertMessage, insertReceipt, deleteMessage, editMessage, addReaction, toggleReaction, removeReaction } from '../repos/chat.repo.js'
import { supabase } from '../config/supabase.js'

let ioRef: IOServer | null = null
export function emitToUser(userId: string, event: string, payload: any) {
  try {
    ioRef?.to(userId).emit(event, payload)
  } catch {}
}

export function initSocket(server: Server) {
  const io = new IOServer(server, {
    path: '/ws',
    cors: { origin: '*', credentials: true }
  })
  ioRef = io

  io.use(async (socket, next) => {
    try {
      const rawHeader = socket.handshake.headers.authorization?.toString()
      const token = (socket.handshake.auth?.token as string | undefined) || (rawHeader?.startsWith('Bearer ') ? rawHeader.slice(7) : undefined)
      if (!token) return next()
      const payload = verifyJwt<{ sub: string; email: string; username: string }>(token)
      if (payload) (socket.data as any).user = { id: payload.sub, email: payload.email, username: payload.username }
      next()
    } catch (e) {
      next()
    }
  })

  const roomCounts = new Map<string, number>() // key: chat:{chatId} -> count

  function bumpRoom(io: IOServer, room: string, delta: number) {
    const prev = roomCounts.get(room) || 0
    const next = Math.max(0, prev + delta)
    roomCounts.set(room, next)
    const chatId = room.startsWith('chat:') ? room.slice(5) : undefined
    if (chatId) {
      io.to(room).emit('chat:presence', { chatId, online: next > 1 })
    }
  }

  io.on('connection', (socket) => {
    logger.info({ id: socket.id, user: (socket.data as any).user }, 'socket connected')

    const user = (socket.data as any).user
    if (user?.id) {
      try { socket.join(user.id) } catch {}
    }

    socket.on('ping', () => socket.emit('pong', { ts: Date.now() }))

    socket.on('broadcast', (payload) => {
      io.emit('broadcast', { from: (socket.data as any).user?.id, payload })
    })

    // Chat: edit message (owner only)
    socket.on('chat:edit', async ({ messageId, text }: { messageId: string; text: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!userId || !messageId || !text?.trim()) return
      try {
        const updatedMessage = await editMessage(messageId, userId, text.trim())
        // Get chat ID from the message
        const chatId = updatedMessage.chat_id
        io.to(`chat:${chatId}`).emit('chat:message:edited', { chatId, messageId, text: text.trim() })
      } catch (e) {
        console.error('Socket edit message error:', e)
      }
    })

    // Chat: delete message (owner only)
    socket.on('chat:delete', async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !messageId) return
      try {
        await deleteMessage(chatId, messageId, userId)
        io.to(`chat:${chatId}`).emit('chat:message:deleted', { chatId, messageId })
      } catch (e) {
        console.error('Socket delete message error:', e)
      }
    })

    // Chat: join a chat room to receive events
    socket.on('chat:join', async ({ chatId }: { chatId: string }) => {
      if (!chatId) return
      const room = `chat:${chatId}`
      try { socket.join(room) } catch {}
      // send recent history (camelCase) with reactions
      try {
        const rows = await getChatMessages(chatId, 30)
        const msgs = rows.map(r => ({ 
          id: r.id, 
          chatId: r.chat_id, 
          senderId: r.sender_id, 
          text: r.text, 
          createdAt: new Date(r.created_at).getTime(),
          updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : undefined,
          isEdited: r.is_edited || false,
          isDeleted: r.is_deleted || false,
          reactions: (r as any).reactions?.map((reaction: any) => ({
            id: reaction.id,
            messageId: r.id,
            userId: reaction.user_id,
            emoji: reaction.emoji,
            createdAt: reaction.created_at
          })) || []
        }))
        socket.emit('chat:history', { chatId, messages: msgs })
      } catch (e) {}
      bumpRoom(io, room, 1)
    })

    // Chat: leave room
    socket.on('chat:leave', ({ chatId }: { chatId: string }) => {
      if (!chatId) return
      const room = `chat:${chatId}`
      try { socket.leave(room) } catch {}
      bumpRoom(io, room, -1)
    })

    // Chat: typing indicator
    socket.on('chat:typing', async ({ chatId, typing }: { chatId: string; typing: boolean }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId) return
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
      } catch (e) {
        console.error('Failed to send typing indicator to members:', e)
      }
    })

    // Chat: send message
    socket.on('chat:message', async ({ chatId, text }: { chatId: string; text: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !text?.trim()) return
      
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
        
        const row = await insertMessage(chatId, userId, text.trim())
        const msg = { id: row.id, chatId: row.chat_id, senderId: row.sender_id, text: row.text, createdAt: new Date(row.created_at).getTime() }
        
        // Send to chat room (for users actively in the chat)
        io.to(`chat:${chatId}`).emit('chat:message', { message: msg })
        
        // Also send to all chat members individually (for background delivery)
        try {
          const { data: members } = await supabase
            .from('chat_members')
            .select('user_id')
            .eq('chat_id', chatId)
          
          // Get sender info for notifications
          const { data: senderInfo, error: senderError } = await supabase
            .from('profiles')
            .select('first_name, last_name, username, email')
            .eq('id', userId)
            .single()
          
          if (senderError) {
            console.error('Error fetching sender info:', senderError)
          }
          
          console.log('Sender info from DB:', senderInfo) // Debug log
          
          const senderName = senderInfo 
            ? (senderInfo.first_name && senderInfo.last_name 
                ? `${senderInfo.first_name} ${senderInfo.last_name}`.trim()
                : senderInfo.username || senderInfo.email?.split('@')[0] || 'Someone')
            : 'Someone'
            
          console.log('Resolved sender name:', senderName) // Debug log
          
          if (members) {
            members.forEach((member: { user_id: string }) => {
              if (member.user_id !== userId) { // Don't send to sender
                io.to(member.user_id).emit('chat:message:background', { 
                  message: { 
                    ...msg, 
                    senderName 
                  } 
                })
              }
            })
          }
        } catch (e) {
          console.error('Failed to send background message:', e)
        }
      } catch (e) {}
    })

    // Chat: delivery receipt
    socket.on('chat:delivered', async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !messageId) return
      try { await insertReceipt(messageId, userId, 'delivered') } catch {}
      socket.to(`chat:${chatId}`).emit('chat:delivered', { chatId, messageId, by: userId })
    })

    // Chat: read receipt
    socket.on('chat:read', async ({ chatId, messageId }: { chatId: string; messageId: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !messageId) return
      try {
        await insertReceipt(messageId, userId, 'read')
        await insertReceipt(messageId, userId, 'delivered')
      } catch {}
      
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
      } catch (e) {
        console.error('Failed to send read receipt to members:', e)
      }
    })

    // Chat: toggle reaction (WhatsApp style)
    socket.on('chat:reaction:toggle', async ({ chatId, messageId, emoji }: { chatId: string; messageId: string; emoji: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !messageId || !emoji) return
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
              console.error('Error fetching sender info for reaction:', senderError)
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
          } catch (e) {
            console.error('Failed to send reaction notification:', e)
          }
        } else if (result.action === 'removed' && result.reaction) {
          io.to(`chat:${chatId}`).emit('chat:reaction:removed', { chatId, messageId, userId, emoji })
        }
      } catch (e) {
        console.error('Socket reaction toggle error:', e)
      }
    })

    // Keep the old add reaction event for backward compatibility
    socket.on('chat:reaction:add', async ({ chatId, messageId, emoji }: { chatId: string; messageId: string; emoji: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !messageId || !emoji) return
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
      } catch (e) {
        console.error('Socket reaction add error:', e)
      }
    })

    // Chat: remove reaction
    socket.on('chat:reaction:remove', async ({ chatId, messageId, emoji }: { chatId: string; messageId: string; emoji: string }) => {
      const userId: string | undefined = (socket.data as any).user?.id
      if (!chatId || !userId || !messageId || !emoji) return
      try {
        await removeReaction(messageId, userId, emoji)
        io.to(`chat:${chatId}`).emit('chat:reaction:removed', { chatId, messageId, userId, emoji })
      } catch (e) {
        console.error('Socket reaction remove error:', e)
      }
    })

    socket.on('disconnect', (reason) => {
      logger.info({ id: socket.id, reason }, 'socket disconnected')
      // best-effort: decrement all chat rooms this socket was in
      try {
        const rooms = Array.from(socket.rooms)
        rooms.forEach((r) => { if (r.startsWith('chat:')) bumpRoom(io, r, -1) })
      } catch {}
    })
  })

  return io
}
