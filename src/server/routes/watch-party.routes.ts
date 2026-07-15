import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { emitToUser, emitToRoom } from '../sockets/optimized-socket.js'
import {
  endSession,
  extendMemeIds,
  getActiveParticipants,
  getActiveSessionForHost,
  getSession,
  isActiveParticipant,
  joinParty,
  leaveParty,
  setCurrentIndex,
  startOrGetSession,
} from '../repos/watch-party.repo.js'

const router = Router()

function room(sessionId: string) {
  return `watch-party:${sessionId}`
}

/** Starts a watch party snapshotting the host's current feed, or returns their already-active one (idempotent). */
router.post('/start', requireAuth, async (req: AuthRequest, res) => {
  try {
    const hostId = req.user!.id
    const memeIds: string[] = Array.isArray(req.body?.memeIds)
      ? req.body.memeIds.filter((id: unknown) => typeof id === 'string')
      : []
    if (!memeIds.length) return res.status(400).json({ error: 'memeIds is required' })

    const { session, created } = await startOrGetSession(hostId, memeIds)
    res.status(created ? 201 : 200).json({ session, created })
  } catch (error) {
    console.error('Start watch party error:', error)
    res.status(500).json({ error: 'Failed to start watch party' })
  }
})

router.get('/active', requireAuth, async (req: AuthRequest, res) => {
  try {
    const session = await getActiveSessionForHost(req.user!.id)
    res.json({ session })
  } catch (error) {
    console.error('Get active watch party error:', error)
    res.status(500).json({ error: 'Failed to load watch party' })
  }
})

router.get('/:sessionId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const session = await getSession(req.params.sessionId)
    if (!session || session.status === 'ended') return res.status(404).json({ error: 'Watch party not found' })
    const participants = await getActiveParticipants(session.id)
    res.json({ session, participants })
  } catch (error) {
    console.error('Get watch party error:', error)
    res.status(500).json({ error: 'Failed to load watch party' })
  }
})

/** Host appends more meme ids as they paginate further into their feed. */
router.post('/:sessionId/extend', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const session = await getSession(sessionId)
    if (!session || session.status === 'ended') return res.status(404).json({ error: 'Watch party not found' })
    if (session.host_id !== req.user!.id) return res.status(403).json({ error: 'Only the host can extend the feed' })

    const memeIds: string[] = Array.isArray(req.body?.memeIds)
      ? req.body.memeIds.filter((id: unknown) => typeof id === 'string')
      : []
    const updated = await extendMemeIds(sessionId, memeIds)
    res.json({ session: updated })
  } catch (error) {
    console.error('Extend watch party error:', error)
    res.status(500).json({ error: 'Failed to extend watch party' })
  }
})

/** Host moves to a new position in the shared feed; broadcasts live to every joined guest. */
router.post('/:sessionId/advance', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const session = await getSession(sessionId)
    if (!session || session.status === 'ended') return res.status(404).json({ error: 'Watch party not found' })
    if (session.host_id !== req.user!.id) return res.status(403).json({ error: 'Only the host can advance the party' })

    const index = Number(req.body?.index)
    if (!Number.isInteger(index) || index < 0 || index >= session.meme_ids.length) {
      return res.status(400).json({ error: 'index out of range' })
    }

    await setCurrentIndex(sessionId, index)
    emitToRoom(room(sessionId), 'watch-party:advance', { sessionId, currentIndex: index, memeId: session.meme_ids[index] })
    res.json({ success: true, currentIndex: index })
  } catch (error) {
    console.error('Advance watch party error:', error)
    res.status(500).json({ error: 'Failed to advance watch party' })
  }
})

router.post('/:sessionId/join', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const userId = req.user!.id
    const session = await getSession(sessionId)
    if (!session || session.status === 'ended') return res.status(404).json({ error: 'Watch party not found' })

    await joinParty(sessionId, userId)
    const participants = await getActiveParticipants(sessionId)
    emitToRoom(room(sessionId), 'watch-party:participant_joined', { sessionId, userId })

    res.json({ session, participants })
  } catch (error) {
    console.error('Join watch party error:', error)
    res.status(500).json({ error: 'Failed to join watch party' })
  }
})

/** Leaving participant departs; if the host leaves, the whole party ends for everyone. */
router.post('/:sessionId/leave', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const userId = req.user!.id
    const session = await getSession(sessionId)
    if (!session || session.status === 'ended') return res.json({ success: true })

    await leaveParty(sessionId, userId)

    if (session.host_id === userId) {
      await endSession(sessionId)
      emitToRoom(room(sessionId), 'watch-party:ended', { sessionId, reason: 'host_left' })
    } else {
      emitToRoom(room(sessionId), 'watch-party:participant_left', { sessionId, userId })
    }

    res.json({ success: true })
  } catch (error) {
    console.error('Leave watch party error:', error)
    res.status(500).json({ error: 'Failed to leave watch party' })
  }
})

router.post('/:sessionId/end', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const session = await getSession(sessionId)
    if (!session || session.status === 'ended') return res.json({ success: true })
    if (session.host_id !== req.user!.id) return res.status(403).json({ error: 'Only the host can end the party' })

    await endSession(sessionId)
    emitToRoom(room(sessionId), 'watch-party:ended', { sessionId, reason: 'host_ended' })
    res.json({ success: true })
  } catch (error) {
    console.error('End watch party error:', error)
    res.status(500).json({ error: 'Failed to end watch party' })
  }
})

/** Host invites friends via their personal socket room -- guests deep-link in with the session id, there's no separate invite record. */
router.post('/:sessionId/invite', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const hostId = req.user!.id
    const session = await getSession(sessionId)
    if (!session || session.status === 'ended') return res.status(404).json({ error: 'Watch party not found' })
    if (session.host_id !== hostId) return res.status(403).json({ error: 'Only the host can invite to this party' })

    const userIds: string[] = Array.isArray(req.body?.userIds)
      ? req.body.userIds.filter((id: unknown) => typeof id === 'string')
      : []
    if (!userIds.length) return res.status(400).json({ error: 'userIds is required' })

    for (const userId of userIds) {
      emitToUser(userId, 'watch-party:invite', { sessionId, hostId })
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Invite to watch party error:', error)
    res.status(500).json({ error: 'Failed to send invite' })
  }
})

/** Ephemeral reaction broadcast -- not persisted, purely a live overlay for whoever's watching right now. */
router.post('/:sessionId/react', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { sessionId } = req.params
    const userId = req.user!.id
    const emoji = String(req.body?.emoji || '').trim()
    if (!emoji || emoji.length > 8) return res.status(400).json({ error: 'A single emoji is required' })

    if (!(await isActiveParticipant(sessionId, userId))) {
      return res.status(403).json({ error: 'Not an active participant of this watch party' })
    }

    emitToRoom(room(sessionId), 'watch-party:reaction', { sessionId, userId, emoji })
    res.json({ success: true })
  } catch (error) {
    console.error('Watch party reaction error:', error)
    res.status(500).json({ error: 'Failed to send reaction' })
  }
})

export default router
