import { supabase } from '../config/supabase.js'
import { logger } from '../config/logger.js'
import { PromptMatchingService } from './prompt-matching.service.js'
import EmailService from './emailService.js'
import { PushNotificationService } from './pushNotificationService.js'
import { emitToUser } from '../sockets/optimized-socket.js'

/**
 * Beacon Helper Retry Service
 * Handles automatic retry logic when givers don't respond within timeout
 * Implements 1-hour timeout with up to 5 retry attempts
 */

const GIVER_RESPONSE_TIMEOUT = 60 * 60 * 1000 // 1 hour in milliseconds
const MAX_RETRY_ATTEMPTS = 5

export class BeaconRetryService {
  
  /**
   * Start monitoring a help request for timeout
   * Sets up a timeout that will retry finding another giver if no response
   */
  static async startTimeoutMonitoring(requestId: string, currentGiverId: string, attemptNumber: number = 1) {
    try {
      logger.info({ requestId, currentGiverId, attemptNumber }, 'Starting timeout monitoring for help request')
      
      // Schedule timeout check after 1 hour
      setTimeout(async () => {
        await this.checkAndRetryIfNeeded(requestId, currentGiverId, attemptNumber)
      }, GIVER_RESPONSE_TIMEOUT)
      
    } catch (error) {
      logger.error({ error, requestId }, 'Error starting timeout monitoring')
    }
  }
  
  /**
   * Check if giver responded, if not retry with another giver
   */
  private static async checkAndRetryIfNeeded(requestId: string, expectedGiverId: string, attemptNumber: number) {
    try {
      // Get current request status
      const { data: request, error: requestError } = await supabase
        .from('help_requests')
        .select('*, giver_request_attempts(*)')
        .eq('id', requestId)
        .single()
      
      if (requestError || !request) {
        logger.warn({ requestId, error: requestError }, 'Help request not found for timeout check')
        return
      }
      
      // Check if request is still in matched status (waiting for giver response)
      if (request.status !== 'matched') {
        logger.info({ requestId, status: request.status }, 'Request no longer in matched status, skipping retry')
        return
      }
      
      // Check if the giver we're monitoring is still the matched one
      if (request.matched_giver_id !== expectedGiverId) {
        logger.info({ requestId, expectedGiverId, actualGiverId: request.matched_giver_id }, 'Different giver matched, skipping retry')
        return
      }
      
      // Check if giver has responded (chat room created)
      if (request.chat_room_id) {
        logger.info({ requestId, chatRoomId: request.chat_room_id }, 'Giver accepted, no retry needed')
        return
      }
      
      // Giver didn't respond in time - mark attempt as timed out
      await supabase
        .from('giver_request_attempts')
        .update({ 
          status: 'timeout',
          responded_at: new Date().toISOString()
        })
        .eq('help_request_id', requestId)
        .eq('giver_user_id', expectedGiverId)
        .eq('status', 'pending')
      
      logger.info({ requestId, giverId: expectedGiverId, attemptNumber }, 'Giver did not respond within timeout, retrying...')
      
      // Check if we've reached max attempts
      if (attemptNumber >= MAX_RETRY_ATTEMPTS) {
        logger.warn({ requestId, attemptNumber }, 'Max retry attempts reached, stopping search')
        
        // Update request status to declined_all
        await supabase
          .from('help_requests')
          .update({ 
            status: 'declined_all',
            matched_giver_id: null
          })
          .eq('id', requestId)
        
        // Notify receiver that no one accepted
        emitToUser(request.receiver_user_id, 'help_search_status', {
          status: 'error',
          message: 'No helpers responded to your request. Please try again later.',
          progress: 0,
          requestId
        })
        
        // Send push notification
        await PushNotificationService.sendPushNotification(
          request.receiver_user_id,
          {
            title: '❌ Help Request Expired',
            body: 'Unfortunately, no helpers were available to respond to your request. Please try again later.',
            data: {
              type: 'help_request_expired',
              requestId
            }
          }
        )
        
        return
      }
      
      // Get all previously contacted givers to exclude
      const { data: previousAttempts } = await supabase
        .from('giver_request_attempts')
        .select('giver_user_id')
        .eq('help_request_id', requestId)
      
      const excludedGiverIds = previousAttempts?.map(a => a.giver_user_id) || []
      
      // Update request to searching status
      await supabase
        .from('help_requests')
        .update({ 
          status: 'searching',
          matched_giver_id: null,
          attempts_count: attemptNumber
        })
        .eq('id', requestId)
      
      // Notify receiver we're finding another helper
      emitToUser(request.receiver_user_id, 'help_search_status', {
        status: 'searching',
        message: `Looking for another helper... (Attempt ${attemptNumber + 1}/${MAX_RETRY_ATTEMPTS})`,
        progress: 50,
        requestId
      })
      
      // Try to find another giver
      const promptEmbedding = request.prompt_embedding 
        ? (Array.isArray(request.prompt_embedding) ? request.prompt_embedding : JSON.parse(request.prompt_embedding))
        : await PromptMatchingService['generateEmbedding'](request.prompt)
      
      const matchResult = await PromptMatchingService['findAndNotifyGiver'](
        requestId,
        request.receiver_user_id,
        promptEmbedding,
        excludedGiverIds,
        request.prompt
      )
      
      if (matchResult.status === 'matched' && matchResult.matchedGiver) {
        // Update request with new giver
        await supabase
          .from('help_requests')
          .update({ 
            status: 'matched',
            matched_giver_id: matchResult.matchedGiver.giver_user_id,
            attempts_count: attemptNumber + 1
          })
          .eq('id', requestId)
        
        // Start timeout monitoring for new giver
        this.startTimeoutMonitoring(requestId, matchResult.matchedGiver.giver_user_id, attemptNumber + 1)
        
        logger.info({ 
          requestId, 
          newGiverId: matchResult.matchedGiver.giver_user_id, 
          attemptNumber: attemptNumber + 1 
        }, 'Found new giver after timeout, monitoring started')
      } else {
        // No more givers available
        logger.warn({ requestId, attemptNumber }, 'No more givers available for retry')
        
        await supabase
          .from('help_requests')
          .update({ 
            status: 'declined_all',
            matched_giver_id: null
          })
          .eq('id', requestId)
        
        emitToUser(request.receiver_user_id, 'help_search_status', {
          status: 'error',
          message: 'No helpers available right now. Please try again later.',
          progress: 0,
          requestId
        })
        
        await PushNotificationService.sendPushNotification(
          request.receiver_user_id,
          {
            title: '❌ No Helpers Available',
            body: 'We couldn\'t find any available helpers for your request. Please try again later.',
            data: {
              type: 'help_request_no_helpers',
              requestId
            }
          }
        )
      }
      
    } catch (error) {
      logger.error({ error, requestId }, 'Error checking and retrying help request')
    }
  }
  
  /**
   * Send email notification to giver when they receive a help request
   */
  static async sendGiverEmailNotification(
    giverUserId: string,
    requestId: string,
    receiverName: string,
    helpPrompt: string,
    summary: string
  ) {
    try {
      // Get giver email
      const { data: giverProfile } = await supabase
        .from('profiles')
        .select('email, first_name')
        .eq('id', giverUserId)
        .single()
      
      if (!giverProfile?.email) {
        logger.warn({ giverUserId }, 'No email found for giver, skipping email notification')
        return
      }
      
      // Send email
      await EmailService.sendBeaconHelperRequest(
        giverProfile.email,
        giverProfile.first_name || 'Helper',
        receiverName,
        summary || helpPrompt.substring(0, 100),
        requestId
      )
      
      logger.info({ giverUserId, requestId }, 'Sent email notification to giver')
      
    } catch (error) {
      logger.error({ error, giverUserId, requestId }, 'Error sending giver email notification')
    }
  }
}
