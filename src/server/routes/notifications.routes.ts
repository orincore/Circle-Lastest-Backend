import { Router } from 'express';
import { and, eq, ne, or } from 'drizzle-orm';
import { AuthRequest, requireAuth } from '../middleware/auth.js';
import { NotificationService } from '../services/notificationService.js';
import { db } from '../config/db.js';
import { notifications, pushTokens } from '../db/schema.js';
import { cache, cacheKeys, NOTIFICATIONS_TTL, invalidateNotificationsCache } from '../services/cache.js';

const router = Router();

/**
 * Register push notification token
 *
 * Dedup key is (userId, deviceId) when the client sends a deviceId (a
 * stable per-install UUID -- see CircleReact's src/services/deviceId.js),
 * NOT the raw push token: the token itself rotates on reinstall/cache-clear
 * /FCM refresh, so keying on it alone (the old behavior) left an orphaned
 * duplicate row behind on every rotation. Clients that don't yet send a
 * deviceId (older builds) fall back to the previous (userId, token) dedup
 * key unchanged -- see the partial unique index in schema.ts.
 */
router.post('/register-token', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { token, deviceType, deviceName, deviceId } = req.body as {
      token?: string; deviceType?: string; deviceName?: string; deviceId?: string;
    };

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    const ipAddress = req.ip || null;

    // Cross-user guard: this exact token, or this exact device, showing up
    // under a different account (shared/re-sold device, or switching which
    // account is logged in on one phone) must not leave two simultaneously
    // enabled rows across accounts.
    try {
      const otherUserMatch = deviceId
        ? or(eq(pushTokens.token, token), eq(pushTokens.deviceId, deviceId))
        : eq(pushTokens.token, token);
      await db.update(pushTokens)
        .set({ enabled: false, updatedAt: new Date().toISOString() })
        .where(and(otherUserMatch, ne(pushTokens.userId, userId)));
    } catch (cleanupError) {
      console.error('Error disabling token/device for other users:', cleanupError);
      // Continue; not fatal for the current user registration
    }

    // Match this user's existing row by device first (once available), or
    // by the exact token as the legacy fallback -- either match lets a
    // rotated token update the SAME row instead of inserting a duplicate.
    const matchCondition = deviceId
      ? and(eq(pushTokens.userId, userId), or(eq(pushTokens.deviceId, deviceId), eq(pushTokens.token, token)))
      : and(eq(pushTokens.userId, userId), eq(pushTokens.token, token));

    const [existing] = await db.select({ id: pushTokens.id })
      .from(pushTokens)
      .where(matchCondition)
      .limit(1);

    if (existing) {
      await db.update(pushTokens)
        .set({
          token,
          enabled: true,
          deviceType,
          deviceName,
          ipAddress,
          ...(deviceId ? { deviceId } : {}),
          updatedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        })
        .where(eq(pushTokens.id, existing.id));
    } else {
      await db.insert(pushTokens).values({
        userId,
        token,
        deviceType,
        deviceName,
        ipAddress,
        ...(deviceId ? { deviceId } : {}),
        enabled: true,
      });
    }

    res.json({ success: true, message: 'Push token registered successfully' });
  } catch (error) {
    console.error('❌ Error registering push token:', error);
    res.status(500).json({ error: 'Failed to register push token' });
  }
});

/**
 * Unregister (disable) push notification token for current user
 * If a deviceId and/or token is provided, only matching row(s) are disabled.
 * If neither is provided, all tokens for the user are disabled.
 */
router.post('/unregister-token', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const { token, deviceId } = req.body as { token?: string; deviceId?: string };

    let condition;
    if (deviceId && token) {
      condition = and(eq(pushTokens.userId, userId), or(eq(pushTokens.deviceId, deviceId), eq(pushTokens.token, token)));
    } else if (deviceId) {
      condition = and(eq(pushTokens.userId, userId), eq(pushTokens.deviceId, deviceId));
    } else if (token) {
      condition = and(eq(pushTokens.userId, userId), eq(pushTokens.token, token));
    } else {
      condition = eq(pushTokens.userId, userId);
    }

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
