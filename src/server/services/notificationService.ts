import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../config/db.js';
import { notifications, profiles } from '../db/schema.js';
import { emitToUser } from '../sockets/optimized-socket.js';
import { invalidateNotificationsCache } from './cache.js';

export interface NotificationData {
  recipient_id: string;
  sender_id?: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
  /**
   * Whether to also deliver this notification as a push notification
   * (default true). The socket emit below only reaches the app while it is
   * open; without the push, closed apps never see the notification at all.
   * Set to false only when the caller already sends its own dedicated push
   * for this event (e.g. blind date match).
   */
  push?: boolean;
}

export type NotificationType = 
  | 'friend_request'
  | 'friend_request_accepted'
  | 'profile_visit'
  | 'new_match'
  | 'profile_suggestion'
  | 'message_request'
  | 'message_request_accepted'
  | 'friend_unfriended'
  | 'new_message'
  | 'match_expired'
  | 'new_user_suggestion'
  | 'referral_approved'
  | 'referral_rejected'
  | 'referral_paid'
  | 'referral_signup'
  | 'verification_success'
  | 'verification_rejected'
  | 'blind_date_match'
  | 'blind_date_reveal'
  | 'blind_date_ended'
  | 'meme_liked_by_friend'
  | 'meme_discovery'
  | 'birthday_self'
  | 'friend_birthday'
  | 'weather_checkin'
  | 'jam_session_started'
  | 'jam_session_left';

export class NotificationService {
  /**
   * Create a new notification
   */
  static async createNotification(notificationData: NotificationData): Promise<any> {
    try {
      //console.log('📬 Creating notification:', JSON.stringify(notificationData, null, 2));

      // Validate that recipient exists in profiles table
      const [recipientProfile] = await db.select({ id: profiles.id })
        .from(profiles).where(eq(profiles.id, notificationData.recipient_id)).limit(1);

      if (!recipientProfile) {
        console.warn(`Notification skipped: Recipient not found. Recipient ID: ${notificationData.recipient_id}`);
        return null;
      }

      // Validate sender if provided
      if (notificationData.sender_id) {
        const [senderProfile] = await db.select({ id: profiles.id })
          .from(profiles).where(eq(profiles.id, notificationData.sender_id)).limit(1);

        if (!senderProfile) {
          console.warn(`Notification skipped: Sender not found. Sender ID: ${notificationData.sender_id}`);
          return null;
        }
      }

      let notification: typeof notifications.$inferSelect;
      try {
        [notification] = await db.insert(notifications).values({
          recipientId: notificationData.recipient_id,
          senderId: notificationData.sender_id,
          type: notificationData.type,
          title: notificationData.title,
          message: notificationData.message,
          data: notificationData.data || {},
          read: false,
        }).returning();
      } catch (error) {
        console.error('❌ Error creating notification:', error);
        return null;
      }

      // Get sender information separately to avoid schema cache issues
      let senderInfo: { id: string; first_name: string | null; last_name: string | null; profile_photo_url: string | null } | null = null;
      if (notification && notification.senderId) {
        const [sender] = await db.select({
          id: profiles.id, first_name: profiles.firstName, last_name: profiles.lastName, profile_photo_url: profiles.profilePhotoUrl,
        }).from(profiles).where(eq(profiles.id, notification.senderId)).limit(1);
        senderInfo = sender ?? null;
      }

      //console.log('✅ Notification inserted successfully:', JSON.stringify(notification, null, 2));

      // Preserve the original snake_case row shape the rest of the codebase expects.
      const notificationRow = {
        id: notification.id,
        recipient_id: notification.recipientId,
        sender_id: notification.senderId,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        read: notification.read,
        created_at: notification.createdAt,
        updated_at: notification.updatedAt,
      };

      // New notification for the recipient — drop their cached list + count.
      await invalidateNotificationsCache(notificationData.recipient_id);

      // Emit real-time notification to user
      try {
        emitToUser(notificationData.recipient_id, 'notification:new', {
          notification: {
            ...notificationRow,
            sender: senderInfo,
            timestamp: new Date(notificationRow.created_at as string)
          }
        });
        //console.log('✅ Real-time notification emitted to user:', notificationData.recipient_id);
      } catch (emitError) {
        console.error('❌ Failed to emit real-time notification:', emitError);
      }

      // Also deliver as a push notification so the recipient sees it when the
      // app is closed — the socket emit above only works for open apps.
      // Fire-and-forget: push delivery must never block or fail the in-app path.
      if (notificationData.push !== false) {
        import('./pushNotificationService.js')
          .then(({ PushNotificationService }) =>
            PushNotificationService.sendPushNotification(notificationData.recipient_id, {
              title: notificationData.title,
              body: notificationData.message,
              data: { type: notificationData.type, ...(notificationData.data || {}) },
              sound: 'default',
              priority: 'high',
            })
          )
          .catch((pushError) => {
            console.error('❌ Failed to send push for notification:', pushError);
          });
      }

      //console.log('✅ Notification created successfully:', notification.id);
      return { ...notificationRow, sender: senderInfo };
    } catch (error) {
      console.error('❌ Failed to create notification:', error);
      console.error('❌ Stack trace:', (error as Error).stack);
      return null;
    }
  }

  /**
   * Get notifications for a user
   */
  static async getUserNotifications(userId: string, limit: number = 50): Promise<any[]> {
    try {
      const rows = await db.select().from(notifications)
        .where(eq(notifications.recipientId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(limit);

      const results: any[] = [];
      // Get sender information separately for each notification
      for (const notification of rows) {
        let sender = null;
        if (notification.senderId) {
          const [senderRow] = await db.select({
            id: profiles.id, first_name: profiles.firstName, last_name: profiles.lastName, profile_photo_url: profiles.profilePhotoUrl,
          }).from(profiles).where(eq(profiles.id, notification.senderId)).limit(1);
          sender = senderRow ?? null;
        }
        results.push({
          id: notification.id,
          recipient_id: notification.recipientId,
          sender_id: notification.senderId,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          data: notification.data,
          read: notification.read,
          created_at: notification.createdAt,
          updated_at: notification.updatedAt,
          sender,
        });
      }

      return results;
    } catch (error) {
      console.error('❌ Failed to fetch notifications:', error);
      return [];
    }
  }

  /**
   * Mark notification as read
   */
  static async markAsRead(notificationId: string, userId: string): Promise<boolean> {
    try {
      await db.update(notifications).set({ read: true })
        .where(and(eq(notifications.id, notificationId), eq(notifications.recipientId, userId)));

      await invalidateNotificationsCache(userId);
      return true;
    } catch (error) {
      console.error('❌ Failed to mark notification as read:', error);
      return false;
    }
  }

  /**
   * Delete notification
   */
  static async deleteNotification(notificationId: string, userId: string): Promise<boolean> {
    try {
      await db.delete(notifications)
        .where(and(eq(notifications.id, notificationId), eq(notifications.recipientId, userId)));

      await invalidateNotificationsCache(userId);

      // Emit real-time notification deletion
      emitToUser(userId, 'notification:deleted', { notificationId });

      return true;
    } catch (error) {
      console.error('❌ Failed to delete notification:', error);
      return false;
    }
  }

  /**
   * Delete friend request notifications between two users
   */
  static async deleteFriendRequestNotifications(userId1: string, userId2: string): Promise<boolean> {
    try {
      //console.log(`🗑️ Deleting friend request notifications between ${userId1} and ${userId2}`);

      // Delete notifications where userId1 is recipient and userId2 is sender
      await db.delete(notifications).where(and(
        eq(notifications.recipientId, userId1),
        eq(notifications.senderId, userId2),
        eq(notifications.type, 'friend_request'),
      ));

      // Delete notifications where userId2 is recipient and userId1 is sender
      await db.delete(notifications).where(and(
        eq(notifications.recipientId, userId2),
        eq(notifications.senderId, userId1),
        eq(notifications.type, 'friend_request'),
      ));

      await invalidateNotificationsCache(userId1);
      await invalidateNotificationsCache(userId2);

      // Emit real-time notification deletion to both users
      emitToUser(userId1, 'notification:friend_request_removed', { otherUserId: userId2 });
      emitToUser(userId2, 'notification:friend_request_removed', { otherUserId: userId1 });

      //console.log('✅ Friend request notifications deleted successfully');
      return true;
    } catch (error) {
      console.error('❌ Failed to delete friend request notifications:', error);
      return false;
    }
  }

  /**
   * Get unread notification count
   */
  static async getUnreadCount(userId: string): Promise<number> {
    try {
      const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
        .from(notifications)
        .where(and(eq(notifications.recipientId, userId), eq(notifications.read, false)));

      return count || 0;
    } catch (error) {
      console.error('❌ Failed to get unread count:', error);
      return 0;
    }
  }

  /**
   * Create notification for friend request accepted
   */
  static async notifyFriendRequestAccepted(senderId: string, acceptedById: string, acceptedByName: string): Promise<void> {
    await this.createNotification({
      recipient_id: senderId,
      sender_id: acceptedById,
      type: 'friend_request_accepted',
      title: 'Friend Request Accepted',
      message: `${acceptedByName} accepted your friend request`,
      data: { action: 'friend_request_accepted' }
    });
  }

  /**
   * Create notification for profile visit
   */
  static async notifyProfileVisit(profileOwnerId: string, visitorId: string, visitorName: string): Promise<void> {
    try {
      // Create in-app notification; createNotification also delivers the
      // push (with this data payload) so the owner is notified even when
      // the app is closed.
      await this.createNotification({
        recipient_id: profileOwnerId,
        sender_id: visitorId,
        type: 'profile_visit',
        title: '👀 Profile Visit',
        message: `${visitorName} visited your profile`,
        data: {
          action: 'profile_visit',
          userId: visitorId,
          screen: 'profile-view',
          params: { userId: visitorId }
        }
      });

      //console.log('✅ Profile visit notification created successfully');
    } catch (error) {
      console.error('❌ Failed to create profile visit notification:', error);
      throw error;
    }
  }

  /**
   * Create notification for new match
   */
  static async notifyNewMatch(userId: string, matchedUserId: string, matchedUserName: string): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      sender_id: matchedUserId,
      type: 'new_match',
      title: 'New Match!',
      message: `You matched with ${matchedUserName}`,
      data: { action: 'new_match' }
    });
  }

  /**
   * Notify the other chat participant that a jam session was just started for their chat.
   */
  static async notifyJamSessionStarted(recipientId: string, starterId: string, starterName: string, chatId: string): Promise<void> {
    await this.createNotification({
      recipient_id: recipientId,
      sender_id: starterId,
      type: 'jam_session_started',
      title: '🎧 Jam Session',
      message: `${starterName} started a Jamming session, waiting for you!`,
      data: {
        action: 'jam_session_started',
        chatId,
        senderId: starterId,
        senderName: starterName,
        screen: 'chat-conversation',
        params: { id: chatId },
      },
    });
  }

  /**
   * Notify a chat participant that the other member left/ended the jam session.
   */
  static async notifyJamSessionLeft(recipientId: string, leaverId: string, leaverName: string, chatId: string): Promise<void> {
    await this.createNotification({
      recipient_id: recipientId,
      sender_id: leaverId,
      type: 'jam_session_left',
      title: '🎧 Jam Session',
      message: `${leaverName} left the jamming session`,
      data: {
        action: 'jam_session_left',
        chatId,
        senderId: leaverId,
        senderName: leaverName,
        screen: 'chat-conversation',
        params: { id: chatId },
      },
      // This fires for both participants (including the person who just
      // tapped "end" themselves) -- their own client already knows they
      // left, a push would be redundant noise for them.
      push: recipientId !== leaverId,
    });
  }

  /**
   * Create notification for profile suggestion
   */
  static async notifyProfileSuggestion(userId: string, suggestedUserId: string, suggestedUserName: string): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      sender_id: suggestedUserId,
      type: 'profile_suggestion',
      title: 'Perfect Match Alert',
      message: `Check out ${suggestedUserName}'s profile - they might be perfect for you!`,
      data: { action: 'profile_suggestion' }
    });
  }

  /**
   * Create notification for message request accepted
   */
  static async notifyMessageRequestAccepted(senderId: string, acceptedById: string, acceptedByName: string): Promise<void> {
    await this.createNotification({
      recipient_id: senderId,
      sender_id: acceptedById,
      type: 'message_request_accepted',
      title: 'Message Request Accepted',
      message: `${acceptedByName} accepted your message request`,
      data: { action: 'message_request_accepted' }
    });
  }

  /**
   * Notify users about new user signup (for potential matches)
   */
  static async notifyNewUserSignup(newUserId: string, newUserName: string, potentialMatchIds: string[]): Promise<void> {
    const newNotifications = potentialMatchIds.map(userId => ({
      recipientId: userId,
      senderId: newUserId,
      type: 'new_user_suggestion' as NotificationType,
      title: 'New User Alert',
      message: `${newUserName} just joined Circle and might be a great match for you!`,
      data: { action: 'new_user_suggestion' }
    }));

    // Batch create notifications
    try {
      await db.insert(notifications).values(newNotifications);

      // Invalidate each recipient's notification cache.
      await Promise.all(potentialMatchIds.map(userId => invalidateNotificationsCache(userId)));

      // Emit real-time notifications
      potentialMatchIds.forEach(userId => {
        emitToUser(userId, 'notification:new', {
          notification: {
            type: 'new_user_suggestion',
            title: 'New User Alert',
            message: `${newUserName} just joined Circle and might be a great match for you!`,
            timestamp: new Date()
          }
        });
      });

      //console.log(`✅ Created ${newNotifications.length} new user notifications`);
    } catch (error) {
      console.error('❌ Failed to create new user notifications:', error);
    }
  }

  /**
   * Notify user when someone signs up using their referral code
   */
  static async notifyReferralSignup(referrerId: string, referredUserName: string, referralNumber: string): Promise<void> {
    await this.createNotification({
      recipient_id: referrerId,
      type: 'referral_signup',
      title: '🎉 New Referral!',
      message: `${referredUserName} just signed up using your referral code! Referral #${referralNumber}`,
      data: { 
        action: 'referral_signup',
        referral_number: referralNumber
      }
    });
  }

  /**
   * Notify user when their referral is approved
   */
  static async notifyReferralApproved(userId: string, referralNumber: string, amount: number): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      type: 'referral_approved',
      title: '✅ Referral Approved!',
      message: `Your referral #${referralNumber} has been approved! ₹${amount} added to your pending earnings.`,
      data: { 
        action: 'referral_approved',
        referral_number: referralNumber,
        amount
      }
    });
  }

  /**
   * Notify user when their referral is rejected
   */
  static async notifyReferralRejected(userId: string, referralNumber: string, reason: string): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      type: 'referral_rejected',
      title: '❌ Referral Rejected',
      message: `Your referral #${referralNumber} was rejected. Reason: ${reason}`,
      data: { 
        action: 'referral_rejected',
        referral_number: referralNumber,
        reason
      }
    });
  }

  /**
   * Notify user when their referral payment is completed
   */
  static async notifyReferralPaid(userId: string, referralNumber: string, amount: number, paymentReference?: string): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      type: 'referral_paid',
      title: '💰 Payment Completed!',
      message: `Payment of ₹${amount} for referral #${referralNumber} has been completed!${paymentReference ? ` Reference: ${paymentReference}` : ''}`,
      data: { 
        action: 'referral_paid',
        referral_number: referralNumber,
        amount,
        payment_reference: paymentReference
      }
    });
  }

  /**
   * Notify user when face verification is successful
   */
  static async notifyVerificationSuccess(userId: string): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      type: 'verification_success',
      title: '✅ Verification Successful!',
      message: 'Your face verification has been approved. You now have full access to all features!',
      data: { 
        action: 'verification_approved'
      }
    });
  }

  /**
   * Notify user when face verification is rejected
   */
  static async notifyVerificationRejected(userId: string, reason: string): Promise<void> {
    await this.createNotification({
      recipient_id: userId,
      type: 'verification_rejected',
      title: '❌ Verification Failed',
      message: `Your verification was not successful. ${reason}`,
      data: { 
        action: 'verification_rejected',
        reason
      }
    });
  }
}
