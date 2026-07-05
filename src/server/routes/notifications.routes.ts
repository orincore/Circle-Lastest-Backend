import { Router } from 'express';
import { and, eq, ne } from 'drizzle-orm';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { NotificationService } from '../services/notificationService.js';
import { db } from '../config/db.js';
import { notifications, pushTokens } from '../db/schema.js';
import { cache, cacheKeys, NOTIFICATIONS_TTL, invalidateNotificationsCache } from '../services/cache.js';

const router = Router();

/**
 * Register push notification token
 */
router.post('/register-token', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { token, deviceType, deviceName } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    //console.log(`📱 Registering push token for user ${userId}:`, { token, deviceType, deviceName });

    // Ensure this token is not active for any other users
    try {
      await db.update(pushTokens)
        .set({ enabled: false, updatedAt: new Date().toISOString() })
        .where(and(eq(pushTokens.token, token), ne(pushTokens.userId, userId)));
    } catch (cleanupError) {
      console.error('Error disabling token for other users:', cleanupError);
      // Continue; not fatal for the current user registration
    }

    // Check if token already exists for this user
    const [existingToken] = await db.select({ id: pushTokens.id })
      .from(pushTokens)
      .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)))
      .limit(1);

    if (existingToken) {
      // Update existing token
      await db.update(pushTokens)
        .set({
          enabled: true,
          deviceType,
          deviceName,
          updatedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        })
        .where(eq(pushTokens.id, existingToken.id));
      //console.log('✅ Push token updated');
    } else {
      // Insert new token
      await db.insert(pushTokens).values({
        userId,
        token,
        deviceType,
        deviceName,
        enabled: true,
      });
      //console.log('✅ Push token registered');
    }

    res.json({ success: true, message: 'Push token registered successfully' });
  } catch (error) {
    console.error('❌ Error registering push token:', error);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

/**
 * Unregister (disable) push notification token for current user
 * If a token is provided, only that token is disabled.
 * If no token is provided, all tokens for the user are disabled.
 */
router.post('/unregister-token', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { token } = req.body as { token?: string };

    const condition = token
      ? and(eq(pushTokens.userId, userId), eq(pushTokens.token, token))
      : eq(pushTokens.userId, userId);

    await db.update(pushTokens)
      .set({ enabled: false, updatedAt: new Date().toISOString() })
      .where(condition);

    res.json({ success: true, message: 'Push token(s) unregistered successfully' });
  } catch (error) {
    console.error('❌ Error unregistering push token:', error);
    res.status(500).json({ error: 'Failed to unregister push token' });
  }
});

/**
 * Get user notifications
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string) || 50;

    // Serve from cache when available; invalidated on any notification write.
    const cacheKey = cacheKeys.notificationList(userId, limit);
    const cached = await cache.getJSON(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const notifications = await NotificationService.getUserNotifications(userId, limit);

    const payload = {
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
    };

    await cache.setJSON(cacheKey, payload, NOTIFICATIONS_TTL);
    res.json(payload);
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

    const cacheKey = cacheKeys.notificationUnread(userId);
    const cached = await cache.getJSON<{ success: boolean; count: number }>(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const count = await NotificationService.getUnreadCount(userId);
    const payload = { success: true, count };
    await cache.setJSON(cacheKey, payload, NOTIFICATIONS_TTL);
    res.json(payload);
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

    await db.update(notifications).set({ read: true })
      .where(and(eq(notifications.recipientId, userId), eq(notifications.read, false)));

    // This route updates the DB directly (not via the service), so invalidate here.
    await invalidateNotificationsCache(userId);

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
