import { supabase } from '../config/supabase.js';
import { emitToUser } from '../sockets/index.js';

export interface NotificationData {
  recipient_id: string;
  sender_id?: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, any>;
}

export type NotificationType = 
  | 'friend_request_accepted'
  | 'profile_visit'
  | 'new_match'
  | 'profile_suggestion'
  | 'message_request_accepted'
  | 'friend_unfriended'
  | 'new_message'
  | 'match_expired'
  | 'new_user_suggestion';

export class NotificationService {
  /**
   * Create a new notification
   */
  static async createNotification(notificationData: NotificationData): Promise<any> {
    try {
      console.log('📬 Creating notification:', notificationData);

      const { data: notification, error } = await supabase
        .from('notifications')
        .insert({
          recipient_id: notificationData.recipient_id,
          sender_id: notificationData.sender_id,
          type: notificationData.type,
          title: notificationData.title,
          message: notificationData.message,
          data: notificationData.data || {},
          read: false
        })
        .select(`
          *,
          sender:sender_id(
            id,
            first_name,
            last_name,
            profile_photo_url
          )
        `)
        .single();

      if (error) {
        console.error('❌ Error creating notification:', error);
        return null;
      }

      // Emit real-time notification to user
      emitToUser(notificationData.recipient_id, 'notification:new', {
        notification: {
          ...notification,
          timestamp: new Date(notification.created_at)
        }
      });

      console.log('✅ Notification created successfully:', notification.id);
      return notification;
    } catch (error) {
      console.error('❌ Failed to create notification:', error);
      return null;
    }
  }

  /**
   * Get notifications for a user
   */
  static async getUserNotifications(userId: string, limit: number = 50): Promise<any[]> {
    try {
      const { data: notifications, error } = await supabase
        .from('notifications')
        .select(`
          *,
          sender:sender_id(
            id,
            first_name,
            last_name,
            profile_photo_url
          )
        `)
        .eq('recipient_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) {
        console.error('❌ Error fetching notifications:', error);
        return [];
      }

      return notifications || [];
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
      const { error } = await supabase
        .from('notifications')
        .update({ read: true })
        .eq('id', notificationId)
        .eq('recipient_id', userId);

      if (error) {
        console.error('❌ Error marking notification as read:', error);
        return false;
      }

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
      const { error } = await supabase
        .from('notifications')
        .delete()
        .eq('id', notificationId)
        .eq('recipient_id', userId);

      if (error) {
        console.error('❌ Error deleting notification:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('❌ Failed to delete notification:', error);
      return false;
    }
  }

  /**
   * Get unread notification count
   */
  static async getUnreadCount(userId: string): Promise<number> {
    try {
      const { count, error } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('recipient_id', userId)
        .eq('read', false);

      if (error) {
        console.error('❌ Error getting unread count:', error);
        return 0;
      }

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
    await this.createNotification({
      recipient_id: profileOwnerId,
      sender_id: visitorId,
      type: 'profile_visit',
      title: 'Profile Visit',
      message: `${visitorName} visited your profile`,
      data: { action: 'profile_visit' }
    });
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
    const notifications = potentialMatchIds.map(userId => ({
      recipient_id: userId,
      sender_id: newUserId,
      type: 'new_user_suggestion' as NotificationType,
      title: 'New User Alert',
      message: `${newUserName} just joined Circle and might be a great match for you!`,
      data: { action: 'new_user_suggestion' }
    }));

    // Batch create notifications
    try {
      const { error } = await supabase
        .from('notifications')
        .insert(notifications);

      if (error) {
        console.error('❌ Error creating new user notifications:', error);
        return;
      }

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

      console.log(`✅ Created ${notifications.length} new user notifications`);
    } catch (error) {
      console.error('❌ Failed to create new user notifications:', error);
    }
  }
}
