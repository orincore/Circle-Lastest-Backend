import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
// Import ioRef dynamically to avoid circular dependency
let getIoRef: (() => any) | null = null;

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
      // Get user's push tokens
      const { data: pushTokens, error } = await supabase
        .from('push_tokens')
        .select('token, device_type, enabled')
        .eq('user_id', userId)
        .eq('enabled', true);

      if (error) {
        logger.error({ error, userId }, 'Error fetching push tokens');
        return false;
      }

      if (!pushTokens || pushTokens.length === 0) {
        logger.debug({ userId }, 'No push tokens found for user');
        return false;
      }

      let successCount = 0;

      // Send to each token
      for (const tokenData of pushTokens) {
        try {
          if (tokenData.device_type === 'web') {
            // Web Push API - handled by service worker
            // For now, we'll use Expo for web too if token is Expo format
            await this.sendExpoPushNotification(tokenData.token, notification);
          } else {
            // Android/iOS - Expo Push Notifications
            await this.sendExpoPushNotification(tokenData.token, notification);
          }
          successCount++;
        } catch (error) {
          logger.error({ error, userId, token: tokenData.token }, 'Failed to send push notification to token');
        }
      }

      return successCount > 0;
    } catch (error) {
      logger.error({ error, userId }, 'Error sending push notification');
      return false;
    }
  }

  /**
   * Send Expo Push Notification
   */
  private static async sendExpoPushNotification(
    token: string,
    notification: PushNotificationData
  ): Promise<boolean> {
    try {
      const isIncomingCall = notification.data && notification.data.type === 'incoming_call';

      const message: any = {
        to: token,
        sound: notification.sound || 'default',
        title: notification.title,
        body: notification.body,
        data: notification.data || {},
        badge: notification.badge,
        priority: notification.priority || 'high',
        channelId: 'default', // Android notification channel
      };

      if (isIncomingCall) {
        message.categoryId = 'call';
      }

      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error({ 
          status: response.status, 
          error: errorText, 
          token 
        }, 'Expo push notification failed');
        return false;
      }

      const result = await response.json();
      
      // Check if notification was successful
      if (result.data && result.data.status === 'ok') {
        logger.debug({ token }, 'Push notification sent successfully');
        return true;
      } else {
        logger.warn({ result, token }, 'Push notification returned non-ok status');
        return false;
      }
    } catch (error) {
      logger.error({ error, token }, 'Error sending Expo push notification');
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
}

