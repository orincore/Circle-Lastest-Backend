/**
 * Active Sessions
 * Listing + remote terminate. Never exposes raw IP or the jti itself to
 * the client.
 */
import { Router } from 'express'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { AuthRequest, requireAuth } from '../middleware/auth.js'
import { db } from '../config/db.js'
import { authSessions } from '../db/schema.js'
import { revokeSession } from '../utils/authSession.js'
import { PushNotificationService } from '../services/pushNotificationService.js'

const router = Router()

/**
 * List the caller's active (non-revoked) sessions
 * GET /api/sessions
 */
router.get('/', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id

    const rows = await db.select({
      id: authSessions.id,
      jti: authSessions.jti,
      deviceType: authSessions.deviceType,
      deviceName: authSessions.deviceName,
      locationCity: authSessions.locationCity,
      locationCountry: authSessions.locationCountry,
      createdAt: authSessions.createdAt,
      lastActiveAt: authSessions.lastActiveAt,
    })
      .from(authSessions)
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .orderBy(desc(authSessions.lastActiveAt))

    const sessions = rows.map(row => ({
      id: row.id,
      deviceType: row.deviceType,
      deviceName: row.deviceName,
      locationCity: row.locationCity,
      locationCountry: row.locationCountry,
      createdAt: row.createdAt,
      lastActiveAt: row.lastActiveAt,
      isCurrent: !!req.jti && row.jti === req.jti,
    }))

    return res.json({ sessions })
  } catch (error) {
    console.error('Get sessions error:', error)
    return res.status(500).json({ error: 'Failed to fetch sessions' })
  }
})

/**
 * Remotely terminate one of the caller's OTHER sessions (a different
 * device). Revokes its jti and disables its push tokens so that device
 * stops receiving pushes and gets rejected on its next request once
 * ENFORCE_SESSION_REVOCATION is on. Terminating your own current session
 * isn't allowed here -- use POST /api/auth/logout for that.
 * POST /api/sessions/:id/terminate
 */
router.post('/:id/terminate', requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id
    const { id } = req.params

    const [session] = await db.select({
      jti: authSessions.jti,
      deviceId: authSessions.deviceId,
      revokedAt: authSessions.revokedAt,
    })
      .from(authSessions)
      .where(and(eq(authSessions.id, id), eq(authSessions.userId, userId)))
      .limit(1)

    if (!session) {
      return res.status(404).json({ error: 'Session not found' })
    }

    if (req.jti && session.jti === req.jti) {
      return res.status(400).json({ error: 'Cannot terminate your current session this way -- use logout instead' })
    }

    if (session.revokedAt) {
      return res.json({ success: true, message: 'Session already terminated' })
    }

    await revokeSession(session.jti, 'remote_terminate')
    await PushNotificationService.disablePushTokensForDevice(userId, { deviceId: session.deviceId })

    return res.json({ success: true, message: 'Session terminated' })
  } catch (error) {
    console.error('Terminate session error:', error)
    return res.status(500).json({ error: 'Failed to terminate session' })
  }
})

export default router
