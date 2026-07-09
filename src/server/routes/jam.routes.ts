import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { emitToUser, emitToRoom } from '../sockets/optimized-socket.js'
import { searchYoutube } from '../services/youtube.service.js'
import {
  addToQueue,
  computeLivePositionMs,
  endSession,
  getActiveSessionForChat,
  getOtherChatMemberId,
  getParticipantPresence,
  getQueueForSession,
  getSession,
  isChatMember,
  joinSession,
  leaveSession,
  markQueueItemStatus,
  removeFromQueue,
  setCurrentTrack,
  setPlaybackState,
  startOrGetSession,
  type JamSession,
} from '../repos/jam.repo.js'

const router = Router()

/** The server never ticks position forward on its own — see computeLivePositionMs. Any
 * session handed to a client needs this applied, not the raw (possibly stale) column. */
function withLivePosition(session: JamSession): JamSession {
  return { ...session, playback_position_ms: computeLivePositionMs(session) }
}

async function requireMembership(req: AuthRequest, res: any, chatId: string): Promise<boolean> {
  const userId = req.user!.id
  if (!(await isChatMember(chatId, userId))) {
    res.status(403).json({ error: 'Not a member of this chat' })
    return false
  }
  return true
}

/** Notifies the other chat participant of a jam lifecycle event over their personal socket room (works even if they haven't joined the session's chat room yet). */
async function notifyOtherMember(chatId: string, userId: string, event: string, payload: any) {
  const otherId = await getOtherChatMemberId(chatId, userId)
  if (otherId) emitToUser(otherId, event, payload)
}

router.get('/search', requireAuth, async (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q ?? '').trim()
    if (q.length < 2) return res.json({ results: [] })
    const results = await searchYoutube(q, { musicOnly: true })
    res.json({ results })
  } catch (error: any) {
    console.error('Jam search error:', error)
    res.status(error?.status ?? 500).json({ error: error?.message ?? 'Search failed' })
  }
})

router.get('/sessions/active', requireAuth, async (req: AuthRequest, res) => {
  try {
    const chatId = String(req.query.chatId ?? '')
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    if (!(await requireMembership(req, res, chatId))) return

    const session = await getActiveSessionForChat(chatId)
    if (!session) return res.json({ session: null, queue: [] })
    const queue = await getQueueForSession(session.id)
    // Presence is normally pushed live via the `jam:presence` socket broadcast, but that's
    // room-scoped — a client that missed a room (re)join after a reconnect would otherwise
    // have no way to recover the current presence state short of leaving and reopening the
    // chat. Including it here lets the client self-heal via its own periodic refresh().
    const presence = await getParticipantPresence(session.id)
    res.json({ session: withLivePosition(session), queue, presence })
  } catch (error) {
    console.error('Get active jam session error:', error)
    res.status(500).json({ error: 'Failed to load jam session' })
  }
})

router.post('/sessions', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { chatId } = req.body
    const userId = req.user!.id
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    if (!(await requireMembership(req, res, chatId))) return

    const { session, created } = await startOrGetSession(chatId, userId)
    const queue = await getQueueForSession(session.id)

    const liveSession = withLivePosition(session)
    if (created) {
      await notifyOtherMember(chatId, userId, 'jam:session:started', { session: liveSession, queue })
    }
    res.status(created ? 201 : 200).json({ session: liveSession, queue, created })
  } catch (error) {
    console.error('Start jam session error:', error)
    res.status(500).json({ error: 'Failed to start jam session' })
  }
})

router.post('/sessions/:id/join', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const userId = req.user!.id
    const session = await getSession(id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (!(await requireMembership(req, res, session.chat_id))) return

    await joinSession(id, userId)
    res.json({ ok: true })
  } catch (error) {
    console.error('Join jam session error:', error)
    res.status(500).json({ error: 'Failed to join jam session' })
  }
})

router.post('/sessions/:id/leave', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const userId = req.user!.id
    const session = await getSession(id)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    await leaveSession(id, userId)
    res.json({ ok: true })
  } catch (error) {
    console.error('Leave jam session error:', error)
    res.status(500).json({ error: 'Failed to leave jam session' })
  }
})

router.post('/sessions/:id/end', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const session = await getSession(id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (!(await requireMembership(req, res, session.chat_id))) return

    await endSession(id)
    await notifyOtherMember(session.chat_id, req.user!.id, 'jam:session:ended', { sessionId: id })
    res.json({ ok: true })
  } catch (error) {
    console.error('End jam session error:', error)
    res.status(500).json({ error: 'Failed to end jam session' })
  }
})

router.post('/sessions/:id/queue', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const userId = req.user!.id
    const { videoId, title, channelTitle, thumbnailUrl, durationSeconds } = req.body
    if (!videoId || !title) return res.status(400).json({ error: 'videoId and title are required' })

    const session = await getSession(id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (!(await requireMembership(req, res, session.chat_id))) return

    const item = await addToQueue({
      sessionId: id, youtubeVideoId: videoId, title, channelTitle, thumbnailUrl, durationSeconds, addedBy: userId,
    })

    // Nothing was cued/playing — this song becomes "now playing" immediately rather than
    // sitting inertly in the queue. (This is the fix for "select a song, nothing happens":
    // the session's current_queue_item_id was never being set at all, so the player never
    // received a video ID to load in the first place.)
    let updatedSession = session
    let becameCurrent = false
    if (!session.current_queue_item_id) {
      await markQueueItemStatus(item.id, 'playing')
      await setCurrentTrack(id, item.id)
      await setPlaybackState(id, { isPlaying: true })
      updatedSession = (await getSession(id))!
      becameCurrent = true
    }

    const queue = await getQueueForSession(id)
    const room = `chat:${session.chat_id}`
    // Broadcast to the chat room so the other participant's client updates live. The adder's
    // own client also gets `queue`/`session` back directly in the response, so it doesn't
    // have to wait on the round-trip through the socket server.
    emitToRoom(room, 'jam:queue:updated', { sessionId: id, queue })
    if (becameCurrent) {
      emitToRoom(room, 'jam:playback:track_changed', { sessionId: id, queueItem: item, positionMs: 0 })
    }
    res.status(201).json({ item, queue, session: updatedSession, becameCurrent })
  } catch (error) {
    console.error('Add to jam queue error:', error)
    res.status(500).json({ error: 'Failed to add to queue' })
  }
})

router.delete('/sessions/:id/queue/:itemId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id, itemId } = req.params
    const session = await getSession(id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (!(await requireMembership(req, res, session.chat_id))) return

    await removeFromQueue(id, itemId)
    const queue = await getQueueForSession(id)
    emitToRoom(`chat:${session.chat_id}`, 'jam:queue:updated', { sessionId: id, queue })
    res.json({ queue })
  } catch (error) {
    console.error('Remove from jam queue error:', error)
    res.status(500).json({ error: 'Failed to remove from queue' })
  }
})

export default router
