import type { Server as IOServer, Socket } from 'socket.io'
import { logger } from '../config/logger.js'
import { PromptMatchingService } from '../services/prompt-matching.service.js'
import { emitToUser } from '../sockets/optimized-socket.js'

/**
 * Socket handlers for prompt-based giver/receiver matching
 */
export function setupPromptMatchingHandlers(io: IOServer, socket: Socket, userId: string) {
  
  /**
   * Giver responds to help request (accept/decline)
   */
  socket.on('giver_response', async (data: { requestId: string; accepted: boolean }) => {
    try {
      const { requestId, accepted } = data

      if (!requestId || typeof accepted !== 'boolean') {
        socket.emit('giver_response_error', { 
          error: 'Invalid request data' 
        })
        return
      }

      logger.info({ 
        userId, 
        requestId, 
        accepted 
      }, 'Giver responding to help request')

      // Handle the response
      const result = await PromptMatchingService.handleGiverResponse(
        requestId,
        userId,
        accepted
      )

      if (result.success) {
        // Confirm to giver
        socket.emit('giver_response_success', {
          requestId,
          accepted,
          chatId: result.chatId,
          message: accepted 
            ? 'Request accepted! Navigating to chat...' 
            : 'Request declined. Finding next helper...'
        })

        logger.info({ 
          userId, 
          requestId, 
          accepted, 
          chatId: result.chatId 
        }, 'Giver response processed successfully')
      } else {
        socket.emit('giver_response_error', {
          requestId,
          error: 'Failed to process response'
        })
      }

    } catch (error) {
      logger.error({ error, userId }, 'Error handling giver response')
      socket.emit('giver_response_error', {
        error: 'Failed to process your response'
      })
    }
  })

  /**
   * Receiver cancels help request
   */
  socket.on('cancel_help_request', async (data: { requestId: string }) => {
    try {
      const { requestId } = data

      if (!requestId) {
        socket.emit('cancel_help_request_error', { 
          error: 'Request ID is required' 
        })
        return
      }

      logger.info({ userId, requestId }, 'Receiver cancelling help request')

      const success = await PromptMatchingService.cancelHelpRequest(requestId, userId)

      if (success) {
        socket.emit('cancel_help_request_success', {
          requestId,
          message: 'Help request cancelled'
        })

        logger.info({ userId, requestId }, 'Help request cancelled successfully')
      } else {
        socket.emit('cancel_help_request_error', {
          requestId,
          error: 'Failed to cancel request'
        })
      }

    } catch (error) {
      logger.error({ error, userId }, 'Error cancelling help request')
      socket.emit('cancel_help_request_error', {
        error: 'Failed to cancel request'
      })
    }
  })

  /**
   * Get giver profile status
   */
  socket.on('get_giver_profile', async () => {
    try {
      const profile = await PromptMatchingService.getGiverProfile(userId)

      socket.emit('giver_profile_data', {
        exists: !!profile,
        profile: profile ? {
          isAvailable: profile.is_available,
          skills: profile.skills,
          categories: profile.categories,
          totalHelpsGiven: profile.total_helps_given,
          averageRating: profile.average_rating
        } : null
      })

    } catch (error) {
      logger.error({ error, userId }, 'Error getting giver profile')
      socket.emit('giver_profile_error', {
        error: 'Failed to get profile'
      })
    }
  })

  /**
   * Toggle giver availability
   */
  socket.on('toggle_giver_availability', async (data: { isAvailable: boolean }) => {
    try {
      const { isAvailable } = data

      if (typeof isAvailable !== 'boolean') {
        socket.emit('toggle_availability_error', { 
          error: 'Invalid availability value' 
        })
        return
      }

      logger.info({ userId, isAvailable }, 'Toggling giver availability')

      // Check if profile exists, create if not
      const existingProfile = await PromptMatchingService.getGiverProfile(userId)
      if (!existingProfile) {
        await PromptMatchingService.createOrUpdateGiverProfile(userId, [], [])
      }

      const success = await PromptMatchingService.toggleGiverAvailability(userId, isAvailable)

      if (success) {
        socket.emit('toggle_availability_success', {
          isAvailable,
          message: isAvailable 
            ? 'You are now available to help' 
            : 'You are now unavailable'
        })

        logger.info({ userId, isAvailable }, 'Giver availability toggled successfully')
      } else {
        socket.emit('toggle_availability_error', {
          error: 'Failed to toggle availability'
        })
      }

    } catch (error) {
      logger.error({ error, userId }, 'Error toggling giver availability')
      socket.emit('toggle_availability_error', {
        error: 'Failed to toggle availability'
      })
    }
  })

  /**
   * Get active help request status
   */
  socket.on('get_active_help_request', async () => {
    try {
      const activeRequest = await PromptMatchingService.getUserActiveRequest(userId)

      socket.emit('active_help_request_data', {
        hasActiveRequest: !!activeRequest,
        request: activeRequest ? {
          id: activeRequest.id,
          prompt: activeRequest.prompt,
          status: activeRequest.status,
          attemptsCount: activeRequest.attempts_count,
          createdAt: activeRequest.created_at,
          expiresAt: activeRequest.expires_at,
          matchedGiverId: activeRequest.matched_giver_id,
          chatRoomId: activeRequest.chat_room_id
        } : null
      })

    } catch (error) {
      logger.error({ error, userId }, 'Error getting active help request')
      socket.emit('active_help_request_error', {
        error: 'Failed to get active request'
      })
    }
  })

  logger.info({ userId }, 'Prompt matching socket handlers registered')
}
