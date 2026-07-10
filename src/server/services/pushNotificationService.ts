import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../config/db.js';
import { profiles, pushTokens } from '../db/schema.js';
import { logger } from '../config/logger.js';
// Import ioRef dynamically to avoid circular dependency
let getIoRef: (() => any) | null = null;

// Expo accepts up to 100 messages per POST to /push/send and /push/getReceipts.
const EXPO_BATCH_LIMIT = 100;
// A ticket only means Expo accepted the message; delivery failures (most
// importantly DeviceNotRegistered for uninstalled apps / rotated FCM tokens)
// only show up in the receipt, which becomes available a short while later.
const RECEIPT_CHECK_DELAY_MS = 60_000;

/**
 * Push notification body for a chat message. Media messages have empty
 * `text`, so a plain `msg.text || 'New message'` fallback would show a
 * generic "New message" for every photo/video/meme — and view-once media
 * must never reveal any real content anyway.
 */
export function describeMessageForNotification(msg: {
  text?: string | null;
  mediaType?: string | null;
  isViewOnce?: boolean;
  sharedMemeId?: string | null;
}): string {
  if (msg.isViewOnce) {
    return msg.mediaType === 'video' ? '🔒 View once video' : '🔒 View once photo';
  }
  if (msg.sharedMemeId) return '😂 Shared a meme';
  if (msg.mediaType === 'video') return '🎥 Video';
  if (msg.mediaType === 'image') return '📷 Photo';
  return msg.text || 'New message';
}

/**
 * Push Notification Service
 * Sends push notifications when users are offline
 * Supports Expo Push Notifications (Android/iOS) and Web Push API (Browser)
 */

export interface PushNotificationData {
  title: string;
  body: string;
  data?: Record<string, any>;
  sound?: string;
  badge?: number;
  priority?: 'default' | 'normal' | 'high';
}

export class PushNotificationService {
  /**
   * Set IO reference (called from socket initialization)
   */
  static setIoRef(io: any) {
    getIoRef = () => io;
  }

  /**
   * Check if user is online (has active socket connection)
   */
  static async isUserOnline(userId: string): Promise<boolean> {
    try {
      const io = getIoRef ? getIoRef() : null;
      if (!io) return false;
      
      // Check if user has any active socket connections
      const sockets = await io.fetchSockets();
      const userSockets = sockets.filter((socket: any) => {
        const user = (socket.data as any)?.user;
        return user?.id === userId;
      });
      
      return userSockets.length > 0;
    } catch (error) {
      logger.error({ error, userId }, 'Error checking user online status');
      return false;
    }
  }

  /**
   * Send push notification to user
   */
  static async sendPushNotification(
    userId: string,
    notification: PushNotificationData
  ): Promise<boolean> {
    try {
      // First verify user account is active and not deleted/suspended
      const [userProfile] = await db.select({ id: profiles.id, deletedAt: profiles.deletedAt, isSuspended: profiles.isSuspended })
        .from(profiles).where(eq(profiles.id, userId)).limit(1);

      if (!userProfile) {
        logger.warn({ userId }, 'User profile not found for push notification');
        return false;
      }

      // Don't send notifications to deleted or suspended accounts
      if (userProfile.deletedAt || userProfile.isSuspended) {
        logger.info({ userId, deleted: !!userProfile.deletedAt, suspended: userProfile.isSuspended }, 'Skipping push notification for inactive account');
        return false;
      }

      // Get user's push tokens
      let userPushTokens: { token: string; device_type: string | null; enabled: boolean | null }[];
      try {
        userPushTokens = await db.select({ token: pushTokens.token, device_type: pushTokens.deviceType, enabled: pushTokens.enabled })
          .from(pushTokens)
          .where(and(eq(pushTokens.userId, userId), eq(pushTokens.enabled, true)));
      } catch (error) {
        logger.error({ error, userId }, 'Error fetching push tokens');
        return false;
      }

      if (!userPushTokens || userPushTokens.length === 0) {
        logger.debug({ userId }, 'No push tokens found for user');
        return false;
      }

      return await this.sendExpoPushNotifications(
        userPushTokens.map(t => t.token),
        notification
      );
    } catch (error) {
      logger.error({ error, userId }, 'Error sending push notification');
      return false;
    }
  }

  /**
   * Disable push tokens that a ticket or receipt reported as dead
   * (DeviceNotRegistered: app uninstalled or FCM/APNs token rotated).
   * Without this, dead tokens accumulate forever and every send to them
   * silently goes nowhere.
   */
  /**
   * Disables push_tokens rows for a specific device (and/or exact token, as
   * a fallback for rows still missing a deviceId) -- used by logout and
   * remote session-terminate so a logged-out device stops receiving pushes
   * immediately, without touching that user's other logged-in devices.
   */
  static async disablePushTokensForDevice(
    userId: string,
    opts: { deviceId?: string | null; token?: string | null },
  ): Promise<void> {
    const { deviceId, token } = opts;
    let condition;
    if (deviceId && token) {
      condition = and(eq(pushTokens.userId, userId), or(eq(pushTokens.deviceId, deviceId), eq(pushTokens.token, token)));
    } else if (deviceId) {
      condition = and(eq(pushTokens.userId, userId), eq(pushTokens.deviceId, deviceId));
    } else if (token) {
      condition = and(eq(pushTokens.userId, userId), eq(pushTokens.token, token));
    } else {
      return; // nothing to disable by -- not an error, just a no-op
    }

    try {
      await db.update(pushTokens)
        .set({ enabled: false, updatedAt: new Date().toISOString() })
        .where(condition);
    } catch (error) {
      logger.error({ error, userId, deviceId, token }, 'Failed to disable push tokens for device');
    }
  }

  private static async disableDeadTokens(tokens: string[], source: 'ticket' | 'receipt'): Promise<void> {
    if (tokens.length === 0) return;
    try {
      await db.update(pushTokens)
        .set({ enabled: false, updatedAt: new Date().toISOString() })
        .where(inArray(pushTokens.token, tokens));
      logger.warn({ tokens, source }, 'Disabled dead push tokens (DeviceNotRegistered)');
    } catch (error) {
      logger.error({ error, tokens }, 'Failed to disable dead push tokens');
    }
  }

  /**
   * Fetch delivery receipts for previously accepted tickets and disable
   * tokens whose receipt says DeviceNotRegistered. Other receipt errors
   * (InvalidCredentials, MessageTooBig, MessageRateExceeded) are logged so
   * delivery problems are visible instead of silently swallowed.
   */
  private static async checkReceipts(tickets: Array<{ id: string; token: string }>): Promise<void> {
    try {
      const response = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: tickets.map(t => t.id) }),
      });
      if (!response.ok) {
        logger.error({ status: response.status }, 'Failed to fetch Expo push receipts');
        return;
      }
      const { data } = await response.json() as { data: Record<string, any> };
      if (!data) return;

      const deadTokens: string[] = [];
      for (const ticket of tickets) {
        const receipt = data[ticket.id];
        if (!receipt || receipt.status === 'ok') continue;
        const errorCode = receipt.details?.error;
        if (errorCode === 'DeviceNotRegistered') {
          deadTokens.push(ticket.token);
        } else {
          logger.error({ token: ticket.token, errorCode, message: receipt.message }, 'Push receipt reported delivery error');
        }
      }
      await this.disableDeadTokens(deadTokens, 'receipt');
    } catch (error) {
      logger.error({ error }, 'Error checking Expo push receipts');
    }
  }

  /**
   * Send one notification to a set of Expo push tokens in a single batched
   * request. Handles ticket-level errors immediately and schedules a receipt
   * check to catch delivery-time failures.
   */
  private static async sendExpoPushNotifications(
    tokens: string[],
    notification: PushNotificationData
  ): Promise<boolean> {
    try {
      const isIncomingCall = notification.data && notification.data.type === 'incoming_call';
      const isNewMessage = notification.data && (notification.data.type === 'new_message' || notification.data.type === 'message');

      const baseMessage: any = {
        sound: notification.sound || 'default',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        badge: notification.badge,
        priority: notification.priority || 'high',
        channelId: 'default', // Android notification channel
      };
      if (isIncomingCall) {
        baseMessage.categoryId = 'call';
      } else if (isNewMessage) {
        baseMessage.categoryId = 'message_reply';
      }

      let successCount = 0;
      for (let i = 0; i < tokens.length; i += EXPO_BATCH_LIMIT) {
        const batch = tokens.slice(i, i + EXPO_BATCH_LIMIT);
        const messages = batch.map(token => ({ ...baseMessage, to: token }));

        const response = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip, deflate',
          },
          body: JSON.stringify(messages),
        });

        if (!response.ok) {
          const errorText = await response.text();
          logger.error({ status: response.status, error: errorText }, 'Expo push notification request failed');
          continue;
        }

        const result = await response.json();
        // Response `data` mirrors the request array: one ticket per message.
        const ticketList: any[] = Array.isArray(result.data) ? result.data : [result.data];

        const deadTokens: string[] = [];
        const acceptedTickets: Array<{ id: string; token: string }> = [];
        ticketList.forEach((ticket, idx) => {
          const token = batch[idx];
          if (!ticket) return;
          if (ticket.status === 'ok') {
            successCount++;
            if (ticket.id) acceptedTickets.push({ id: ticket.id, token });
          } else if (ticket.details?.error === 'DeviceNotRegistered') {
            deadTokens.push(token);
          } else {
            logger.warn({ ticket, token }, 'Push ticket returned non-ok status');
          }
        });

        // Fire-and-forget cleanup + delayed receipt verification; neither
        // should block or fail the send path.
        this.disableDeadTokens(deadTokens, 'ticket').catch(() => {});
        if (acceptedTickets.length > 0) {
          const timer = setTimeout(() => {
            this.checkReceipts(acceptedTickets).catch(() => {});
          }, RECEIPT_CHECK_DELAY_MS);
          // Don't keep the process alive just to check receipts.
          if (typeof timer.unref === 'function') timer.unref();
        }
      }

      return successCount > 0;
    } catch (error) {
      logger.error({ error }, 'Error sending Expo push notifications');
      return false;
    }
  }

  /**
   * Send push notification for new message
   */
  static async sendMessageNotification(
    recipientId: string,
    senderName: string,
    messageText: string,
    chatId: string,
    messageId: string
  ): Promise<boolean> {
    try {
      // If user is actively viewing this chat in the foreground, skip push
      try {
        const io = getIoRef ? getIoRef() : null;
        if (io) {
          const sockets = await io.fetchSockets();
          const recipientSockets = sockets.filter((socket: any) => {
            const user = (socket.data as any)?.user;
            return user?.id === recipientId;
          });

          if (recipientSockets.length > 0) {
            let isActivelyViewingChat = false;
            for (const socket of recipientSockets) {
              const data: any = socket.data || {};
              const activeChats: any = data.activeChats;
              if (Array.isArray(activeChats) && activeChats.includes(chatId)) {
                isActivelyViewingChat = true;
                break;
              }
            }

            if (isActivelyViewingChat) {
              logger.debug({ recipientId, chatId }, 'Skipping push for message because user is actively viewing this chat');
              return false;
            }
          }
        }
      } catch (presenceError) {
        logger.warn({ presenceError, recipientId, chatId }, 'Failed to determine active chat presence; proceeding with push');
      }

      // Truncate message for notification
      const truncatedMessage = messageText.length > 100 
        ? messageText.substring(0, 100) + '...' 
        : messageText;

      return await this.sendPushNotification(recipientId, {
        title: `💬 ${senderName}`,
        body: truncatedMessage,
        data: {
          type: 'new_message',
          chatId,
          messageId,
          senderName,
        },
        sound: 'default',
        priority: 'high',
      });
    } catch (error) {
      logger.error({ error, recipientId }, 'Error sending message push notification');
      return false;
    }
  }

  /**
   * Send push notification for friend request
   */
  static async sendFriendRequestNotification(
    recipientId: string,
    senderName: string,
    requestId: string
  ): Promise<boolean> {
    try {
      return await this.sendPushNotification(recipientId, {
        title: '\ud83d\udc65 New Friend Request',
        body: `${senderName} wants to be your friend`,
        data: {
          type: 'friend_request',
          requestId,
          senderName,
        },
        sound: 'default',
        priority: 'normal',
      });
    } catch (error) {
      logger.error({ error, recipientId }, 'Error sending friend request push notification');
      return false;
    }
  }

  /**
   * Send push notification for match
   */
  static async sendMatchNotification(
    recipientId: string,
    matchedUserName: string,
    matchId: string
  ): Promise<boolean> {
    try {
      return await this.sendPushNotification(recipientId, {
        title: '\ud83d\udc95 New Match!',
        body: `You matched with ${matchedUserName}`,
        data: {
          type: 'new_match',
          matchId,
          matchedUserName,
        },
        sound: 'default',
        priority: 'high',
      });
    } catch (error) {
      logger.error({ error, recipientId }, 'Error sending match push notification');
      return false;
    }
  }

  /**
   * Send push notification for incoming voice call
   */
  static async sendVoiceCallNotification(
    recipientId: string,
    callerId: string,
    callerName: string,
    callId: string
  ): Promise<boolean> {
    try {
      return await this.sendPushNotification(recipientId, {
        title: `📞 Incoming Call`,
        body: `${callerName} is calling you`,
        data: {
          type: 'incoming_call',
          callId,
          callerId,
          callerName,
        },
        sound: 'default',
        priority: 'high',
      });
    } catch (error) {
      logger.error({ error, recipientId }, 'Error sending voice call push notification');
      return false;
    }
  }

  /**
   * Send push notification for new blind date match
   */
  static async sendBlindDateMatchNotification(
    recipientId: string,
    matchId: string,
    chatId: string
  ): Promise<boolean> {
    try {
      return await this.sendPushNotification(recipientId, {
        title: '🎭 New Blind Date Found!',
        body: 'You have a new anonymous match! Start chatting to discover who they are.',
        data: {
          type: 'blind_date_match',
          matchId,
          chatId,
        },
        sound: 'default',
        priority: 'high',
      });
    } catch (error) {
      logger.error({ error, recipientId }, 'Error sending blind date match push notification');
      return false;
    }
  }

  /**
   * Send push notification for blind date identity reveal
   */
  static async sendBlindDateRevealNotification(
    recipientId: string,
    revealerName: string,
    matchId: string,
    chatId: string
  ): Promise<boolean> {
    try {
      return await this.sendPushNotification(recipientId, {
        title: '🎉 Identity Revealed!',
        body: `${revealerName} has revealed their identity to you!`,
        data: {
          type: 'blind_date_reveal',
          matchId,
          chatId,
          revealerName,
        },
        sound: 'default',
        priority: 'high',
      });
    } catch (error) {
      logger.error({ error, recipientId }, 'Error sending blind date reveal push notification');
      return false;
    }
  }
}

