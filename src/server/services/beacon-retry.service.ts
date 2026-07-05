import { eq, and } from 'drizzle-orm'
import { db } from '../config/db.js'
import { helpRequests, giverRequestAttempts, profiles } from '../db/schema.js'
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
      const [request] = await db.select().from(helpRequests).where(eq(helpRequests.id, requestId))

      if (!request) {
        logger.warn({ requestId }, 'Help request not found for timeout check')
        return
      }

      // Check if request is still in matched status (waiting for giver response)
      if (request.status !== 'matched') {
        logger.info({ requestId, status: request.status }, 'Request no longer in matched status, skipping retry')
        return
      }

      // Check if the giver we're monitoring is still the matched one
      if (request.matchedGiverId !== expectedGiverId) {
        logger.info({ requestId, expectedGiverId, actualGiverId: request.matchedGiverId }, 'Different giver matched, skipping retry')
        return
      }

      // Check if giver has responded (chat room created)
      if (request.chatRoomId) {
        logger.info({ requestId, chatRoomId: request.chatRoomId }, 'Giver accepted, no retry needed')
        return
      }

      // Giver didn't respond in time - mark attempt as timed out
      await db.update(giverRequestAttempts)
        .set({
          status: 'timeout',
          respondedAt: new Date().toISOString(),
        })
        .where(and(
          eq(giverRequestAttempts.helpRequestId, requestId),
          eq(giverRequestAttempts.giverUserId, expectedGiverId),
          eq(giverRequestAttempts.status, 'pending'),
        ))

      logger.info({ requestId, giverId: expectedGiverId, attemptNumber }, 'Giver did not respond within timeout, retrying...')

      // Check if we've reached max attempts
      if (attemptNumber >= MAX_RETRY_ATTEMPTS) {
        logger.warn({ requestId, attemptNumber }, 'Max retry attempts reached, stopping search')

        // Update request status to declined_all
        await db.update(helpRequests)
          .set({
            status: 'declined_all',
            matchedGiverId: null,
          })
          .where(eq(helpRequests.id, requestId))

        // Notify receiver that no one accepted
        emitToUser(request.receiverUserId, 'help_search_status', {
          status: 'error',
          message: 'No helpers responded to your request. Please try again later.',
          progress: 0,
          requestId
        })

        // Send push notification
        await PushNotificationService.sendPushNotification(
          request.receiverUserId,
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
      const previousAttempts = await db.select({ giverUserId: giverRequestAttempts.giverUserId })
        .from(giverRequestAttempts)
        .where(eq(giverRequestAttempts.helpRequestId, requestId))

      const excludedGiverIds = previousAttempts?.map(a => a.giverUserId) || []

      // Update request to searching status
      await db.update(helpRequests)
        .set({
          status: 'searching',
          matchedGiverId: null,
          attemptsCount: attemptNumber,
        })
        .where(eq(helpRequests.id, requestId))

      // Notify receiver we're finding another helper
      emitToUser(request.receiverUserId, 'help_search_status', {
        status: 'searching',
        message: `Looking for another helper... (Attempt ${attemptNumber + 1}/${MAX_RETRY_ATTEMPTS})`,
        progress: 50,
        requestId
      })

      // Try to find another giver
      const promptEmbedding = request.promptEmbedding
        ? (Array.isArray(request.promptEmbedding) ? request.promptEmbedding : JSON.parse(request.promptEmbedding as any))
        : await PromptMatchingService['generateEmbedding'](request.prompt)

      const matchResult = await PromptMatchingService['findAndNotifyGiver'](
        requestId,
        request.receiverUserId,
        promptEmbedding,
        excludedGiverIds,
        request.prompt
      )

      if (matchResult.status === 'matched' && matchResult.matchedGiver) {
        // Update request with new giver
        await db.update(helpRequests)
          .set({
            status: 'matched',
            matchedGiverId: matchResult.matchedGiver.giver_user_id,
            attemptsCount: attemptNumber + 1,
          })
          .where(eq(helpRequests.id, requestId))

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

        await db.update(helpRequests)
          .set({
            status: 'declined_all',
            matchedGiverId: null,
          })
          .where(eq(helpRequests.id, requestId))

        emitToUser(request.receiverUserId, 'help_search_status', {
          status: 'error',
          message: 'No helpers available right now. Please try again later.',
          progress: 0,
          requestId
        })

        await PushNotificationService.sendPushNotification(
          request.receiverUserId,
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
      const [giverProfile] = await db.select({
        email: profiles.email,
        firstName: profiles.firstName,
      }).from(profiles).where(eq(profiles.id, giverUserId))

      if (!giverProfile?.email) {
        logger.warn({ giverUserId }, 'No email found for giver, skipping email notification')
        return
      }

      // Send email
      await EmailService.sendBeaconHelperRequest(
        giverProfile.email,
        giverProfile.firstName || 'Helper',
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
