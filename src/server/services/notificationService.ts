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
  | 'verification_rejected';

export class NotificationService {
  /**
   * Create a new notification
   */
  static async createNotification(notificationData: NotificationData): Promise<any> {
    try {
      //console.log('📬 Creating notification:', JSON.stringify(notificationData, null, 2));

      // Validate that recipient exists in profiles table
      const { data: recipientProfile, error: recipientError } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', notificationData.recipient_id)
        .maybeSingle();
      
      if (recipientError) {
        console.error('Error validating recipient profile:', recipientError);
        return null;
      }
      
      if (!recipientProfile) {
        console.warn(`Notification skipped: Recipient not found. Recipient ID: ${notificationData.recipient_id}`);
        return null;
      }

      // Validate sender if provided
      if (notificationData.sender_id) {
        const { data: senderProfile, error: senderError } = await supabase
          .from('profiles')
          .select('id')
          .eq('id', notificationData.sender_id)
          .maybeSingle();
        
        if (senderError) {
          console.error('Error validating sender profile:', senderError);
          return null;
        }
        
        if (!senderProfile) {
          console.warn(`Notification skipped: Sender not found. Sender ID: ${notificationData.sender_id}`);
          return null;
        }
      }

      const insertData = {
        recipient_id: notificationData.recipient_id,
        sender_id: notificationData.sender_id,
        type: notificationData.type,
        title: notificationData.title,
        message: notificationData.message,
        data: notificationData.data || {},
        read: false
      };
      
      //console.log('📝 Inserting notification data:', JSON.stringify(insertData, null, 2));

      const { data: notification, error } = await supabase
        .from('notifications')
        .insert(insertData)
        .select('*')
        .single();
        
      // Get sender information separately to avoid schema cache issues
      let senderInfo = null;
      if (notification && notification.sender_id) {
        const { data: sender } = await supabase
          .from('profiles')
          .select('id, first_name, last_name, profile_photo_url')
          .eq('id', notification.sender_id)
          .single();
        senderInfo = sender;
      }

      if (error) {
        console.error('❌ Error creating notification:', error);
        console.error('❌ Error details:', JSON.stringify(error, null, 2));
        return null;
      }

      //console.log('✅ Notification inserted successfully:', JSON.stringify(notification, null, 2));

      // Emit real-time notification to user
      try {
        emitToUser(notificationData.recipient_id, 'notification:new', {
          notification: {
            ...notification,
            sender: senderInfo,
            timestamp: new Date(notification.created_at)
          }
        });
        //console.log('✅ Real-time notification emitted to user:', notificationData.recipient_id);
      } catch (emitError) {
        console.error('❌ Failed to emit real-time notification:', emitError);
      }

      //console.log('✅ Notification created successfully:', notification.id);
      return { ...notification, sender: senderInfo };
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
      const { data: notifications, error } = await supabase
        .from('notifications')
        .select('*')
        .eq('recipient_id', userId)
        .order('created_at', { ascending: false })
        .limit(limit);
        
      // Get sender information separately for each notification
      if (notifications && notifications.length > 0) {
        for (const notification of notifications) {
          if (notification.sender_id) {
            const { data: sender } = await supabase
              .from('profiles')
              .select('id, first_name, last_name, profile_photo_url')
              .eq('id', notification.sender_id)
              .single();
            notification.sender = sender;
          }
        }
      }

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
      const { error: error1 } = await supabase
        .from('notifications')
        .delete()
        .eq('recipient_id', userId1)
        .eq('sender_id', userId2)
        .eq('type', 'friend_request');

      // Delete notifications where userId2 is recipient and userId1 is sender
      const { error: error2 } = await supabase
        .from('notifications')
        .delete()
        .eq('recipient_id', userId2)
        .eq('sender_id', userId1)
        .eq('type', 'friend_request');

      if (error1 || error2) {
        console.error('❌ Error deleting friend request notifications:', error1 || error2);
        return false;
      }

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
    
    
    try {
      await this.createNotification({
        recipient_id: profileOwnerId,
        sender_id: visitorId,
        type: 'profile_visit',
        title: 'Profile Visit',
        message: `${visitorName} visited your profile`,
        data: { action: 'profile_visit' }
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

      //console.log(`✅ Created ${notifications.length} new user notifications`);
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
