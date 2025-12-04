import { Server as IOServer, Socket } from 'socket.io'
import { logger } from '../config/logger.js'
import { BlindDatingService } from '../services/blind-dating.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'
import { insertMessage } from '../repos/chat.repo.js'

/**
 * Socket handlers for blind dating feature
 */

export function setupBlindDatingHandlers(io: IOServer, socket: Socket, userId: string) {
  // Get blind date status for a chat
  socket.on('blind_date:get_status', async ({ chatId }: { chatId: string }) => {
    try {
      if (!chatId) {
        socket.emit('blind_date:status:error', { error: 'Chat ID required' })
        return
      }

      const status = await BlindDatingService.getChatBlindDateStatus(chatId, userId)
      socket.emit('blind_date:status', status)
    } catch (error) {
      logger.error({ error, userId, chatId }, 'Error getting blind date status')
      socket.emit('blind_date:status:error', { error: 'Failed to get status' })
    }
  })

  // Send message in blind date chat (with filtering)
  socket.on('blind_date:message', async ({ 
    chatId, 
    matchId, 
    text 
  }: { 
    chatId: string
    matchId: string
    text: string 
  }) => {
    try {
      if (!chatId || !text?.trim()) {
        socket.emit('blind_date:message:error', { error: 'Chat ID and message required' })
        return
      }

      // Get match info
      let actualMatchId = matchId
      if (!actualMatchId) {
        const match = await BlindDatingService.getMatchByChatId(chatId)
        if (match) {
          actualMatchId = match.id
        }
      }

      // If this is a blind date chat, filter the message
      if (actualMatchId) {
        const filterResult = await BlindDatingService.filterMessage(text, actualMatchId, userId)
        
        if (!filterResult.allowed) {
          // Message blocked for personal info
          socket.emit('blind_date:message:blocked', {
            chatId,
            matchId: actualMatchId,
            reason: filterResult.blockedReason,
            detectedTypes: filterResult.analysis?.detectedTypes || [],
            message: 'Your message contains personal information and was not sent. Remove personal details like phone numbers, social media handles, or email addresses.'
          })
          
          logger.info({ 
            userId, 
            chatId, 
            matchId: actualMatchId, 
            detectedTypes: filterResult.analysis?.detectedTypes 
          }, 'Blind date message blocked')
          return
        }
      }

      // Message allowed - send it through normal channel
      // The regular chat:message handler will take care of this
      socket.emit('blind_date:message:allowed', {
        chatId,
        text,
        proceed: true
      })
    } catch (error) {
      logger.error({ error, userId, chatId }, 'Error sending blind date message')
      socket.emit('blind_date:message:error', { error: 'Failed to send message' })
    }
  })

  // Request identity reveal - REAL-TIME via socket
  socket.on('blind_date:request_reveal', async ({ matchId, chatId }: { matchId: string; chatId?: string }) => {
    try {
      if (!matchId) {
        socket.emit('blind_date:reveal:error', { error: 'Match ID required' })
        return
      }

      logger.info({ userId, matchId, chatId }, '[BlindDate Socket] Reveal request received')

      const result = await BlindDatingService.requestReveal(matchId, userId)
      
      if (result.success) {
        // Get updated match data
        const match = await BlindDatingService.getMatchById(matchId)
        if (!match) {
          socket.emit('blind_date:reveal:error', { error: 'Match not found' })
          return
        }

        const isUserA = match.user_a === userId
        const otherUserId = isUserA ? match.user_b : match.user_a
        
        // Get profiles for both users
        const [myProfile, otherProfile] = await Promise.all([
          BlindDatingService.getAnonymizedProfile(userId, result.bothRevealed),
          BlindDatingService.getAnonymizedProfile(otherUserId, result.bothRevealed)
        ])

        // Emit success to requesting user with full data
        socket.emit('blind_date:reveal:success', {
          matchId,
          chatId: match.chat_id || chatId,
          bothRevealed: result.bothRevealed,
          message: result.message,
          hasRevealedSelf: true,
          otherHasRevealed: isUserA ? match.user_b_revealed : match.user_a_revealed,
          otherUser: otherProfile,
          otherUserId,
          friendshipCreated: result.bothRevealed,
          match: {
            ...match,
            user_a_revealed: isUserA ? true : match.user_a_revealed,
            user_b_revealed: isUserA ? match.user_b_revealed : true
          }
        })

        logger.info({ userId, matchId, bothRevealed: result.bothRevealed }, '[BlindDate Socket] Reveal success emitted to requester')

        // Note: The BlindDatingService.requestReveal already emits to the other user
        // via emitToUser for 'blind_date:revealed' or 'blind_date:reveal_requested'
      } else {
        socket.emit('blind_date:reveal:error', {
          matchId,
          error: result.message
        })
      }
    } catch (error) {
      logger.error({ error, userId, matchId }, 'Error requesting reveal')
      socket.emit('blind_date:reveal:error', { error: 'Failed to request reveal' })
    }
  })

  // End blind date
  socket.on('blind_date:end', async ({ matchId, reason }: { matchId: string; reason?: string }) => {
    try {
      if (!matchId) {
        socket.emit('blind_date:end:error', { error: 'Match ID required' })
        return
      }

      const success = await BlindDatingService.endMatch(matchId, userId, reason)
      
      if (success) {
        socket.emit('blind_date:end:success', { matchId })
      } else {
        socket.emit('blind_date:end:error', { error: 'Failed to end match' })
      }
    } catch (error) {
      logger.error({ error, userId, matchId }, 'Error ending blind date')
      socket.emit('blind_date:end:error', { error: 'Failed to end match' })
    }
  })

  // Get anonymized profile
  socket.on('blind_date:get_profile', async ({ 
    targetUserId, 
    matchId 
  }: { 
    targetUserId: string
    matchId: string 
  }) => {
    try {
      if (!targetUserId || !matchId) {
        socket.emit('blind_date:profile:error', { error: 'User ID and Match ID required' })
        return
      }

      const match = await BlindDatingService.getMatchById(matchId)
      if (!match) {
        socket.emit('blind_date:profile:error', { error: 'Match not found' })
        return
      }

      // Verify user is part of the match
      if (match.user_a !== userId && match.user_b !== userId) {
        socket.emit('blind_date:profile:error', { error: 'Unauthorized' })
        return
      }

      // Determine if profile should be revealed
      const isUserA = match.user_a === userId
      const isRevealed = match.status === 'revealed' || 
                        (isUserA ? match.user_b_revealed : match.user_a_revealed)

      const profile = await BlindDatingService.getAnonymizedProfile(targetUserId, isRevealed)
      
      socket.emit('blind_date:profile', {
        matchId,
        profile,
        isRevealed
      })
    } catch (error) {
      logger.error({ error, userId, targetUserId, matchId }, 'Error getting blind date profile')
      socket.emit('blind_date:profile:error', { error: 'Failed to get profile' })
    }
  })

  // Check if reveal is available
  socket.on('blind_date:check_reveal', async ({ matchId }: { matchId: string }) => {
    try {
      if (!matchId) {
        socket.emit('blind_date:reveal_check:error', { error: 'Match ID required' })
        return
      }

      const match = await BlindDatingService.getMatchById(matchId)
      if (!match) {
        socket.emit('blind_date:reveal_check:error', { error: 'Match not found' })
        return
      }

      const canReveal = BlindDatingService.isRevealAvailable(match)
      const messagesUntilReveal = Math.max(0, match.reveal_threshold - match.message_count)

      const isUserA = match.user_a === userId
      socket.emit('blind_date:reveal_check', {
        matchId,
        canReveal,
        messagesUntilReveal,
        currentMessageCount: match.message_count,
        threshold: match.reveal_threshold,
        hasRevealedSelf: isUserA ? match.user_a_revealed : match.user_b_revealed,
        otherHasRevealed: isUserA ? match.user_b_revealed : match.user_a_revealed
      })
    } catch (error) {
      logger.error({ error, userId, matchId }, 'Error checking reveal availability')
      socket.emit('blind_date:reveal_check:error', { error: 'Failed to check reveal' })
    }
  })

  // Get active blind dates
  socket.on('blind_date:get_matches', async () => {
    try {
      const matches = await BlindDatingService.getActiveMatches(userId)
      
      // Enrich with anonymized profiles
      const enrichedMatches = await Promise.all(
        matches.map(async (match) => {
          const isUserA = match.user_a === userId
          const otherUserId = isUserA ? match.user_b : match.user_a
          const isRevealed = match.status === 'revealed' || 
                            (isUserA ? match.user_b_revealed : match.user_a_revealed)
          
          const otherUserProfile = await BlindDatingService.getAnonymizedProfile(otherUserId, isRevealed)
          
          return {
            ...match,
            otherUser: otherUserProfile,
            canReveal: BlindDatingService.isRevealAvailable(match),
            messagesUntilReveal: Math.max(0, match.reveal_threshold - match.message_count),
            hasRevealedSelf: isUserA ? match.user_a_revealed : match.user_b_revealed,
            otherHasRevealed: isUserA ? match.user_b_revealed : match.user_a_revealed
          }
        })
      )

      socket.emit('blind_date:matches', { matches: enrichedMatches })
    } catch (error) {
      logger.error({ error, userId }, 'Error getting blind date matches')
      socket.emit('blind_date:matches:error', { error: 'Failed to get matches' })
    }
  })

  logger.debug({ userId }, 'Blind dating socket handlers registered')
}

