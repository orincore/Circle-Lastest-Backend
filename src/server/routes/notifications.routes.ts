import { Router } from 'express';
import { AuthRequest, requireAuth } from '../middleware/auth';
import { NotificationService } from '../services/notificationService';

const router = Router();

/**
 * Get user notifications
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 50;

    const notifications = await NotificationService.getUserNotifications(userId, limit);
    
    res.json({
      success: true,
      notifications: notifications.map(notification => ({
        id: notification.id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        data: notification.data,
        read: notification.read,
        timestamp: new Date(notification.created_at),
        sender: notification.sender ? {
          id: notification.sender.id,
          name: `${notification.sender.first_name} ${notification.sender.last_name}`.trim(),
          avatar: notification.sender.profile_photo_url
        } : null
      }))
    });
  } catch (error) {
    console.error('❌ Error fetching notifications:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch notifications' 
    });
  }
});

/**
 * Get unread notification count
 */
router.get('/unread-count', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const count = await NotificationService.getUnreadCount(userId);
    
    res.json({
      success: true,
      count
    });
  } catch (error) {
    console.error('❌ Error fetching unread count:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to fetch unread count' 
    });
  }
});

/**
 * Mark notification as read
 */
router.patch('/:notificationId/read', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { notificationId } = req.params;

    const success = await NotificationService.markAsRead(notificationId, userId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Notification marked as read'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Notification not found or access denied'
      });
    }
  } catch (error) {
    console.error('❌ Error marking notification as read:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to mark notification as read' 
    });
  }
});

/**
 * Delete notification
 */
router.delete('/:notificationId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { notificationId } = req.params;

    const success = await NotificationService.deleteNotification(notificationId, userId);
    
    if (success) {
      res.json({
        success: true,
        message: 'Notification deleted successfully'
      });
    } else {
      res.status(404).json({
        success: false,
        error: 'Notification not found or access denied'
      });
    }
  } catch (error) {
    console.error('❌ Error deleting notification:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to delete notification' 
    });
  }
});

/**
 * Mark all notifications as read
 */
router.patch('/mark-all-read', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;

    const { error } = await require('../config/database').supabase
      .from('notifications')
      .update({ read: true })
      .eq('recipient_id', userId)
      .eq('read', false);

    if (error) {
      throw error;
    }

    res.json({
      success: true,
      message: 'All notifications marked as read'
    });
  } catch (error) {
    console.error('❌ Error marking all notifications as read:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to mark all notifications as read' 
    });
  }
});

export default router;
