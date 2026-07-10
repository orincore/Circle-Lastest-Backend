import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { emitToUser, emitToRoom } from '../sockets/optimized-socket.js'
import { searchYoutube } from '../services/youtube.service.js'
import { NotificationService } from '../services/notificationService.js'
import {
  addToQueue,
  computeLivePositionMs,
  endSession,
  getActiveSessionForChat,
  getOtherChatMemberId,
  getParticipantPresence,
  getQueueForSession,
  getSession,
  getUserDisplayName,
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
import {
  addPlaylistTrack,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  getPlaylistsForChat,
  getPlaylistTracks,
  removePlaylistTrack,
  renamePlaylist,
  reorderPlaylistTracks,
} from '../repos/playlist.repo.js'

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

      // Persisted + push notification (in addition to the live socket event
      // above, which only reaches an already-open app) so the other member
      // finds out even if they're not in the chat right now.
      const otherId = await getOtherChatMemberId(chatId, userId)
      if (otherId) {
        const starterName = await getUserDisplayName(userId)
        NotificationService.notifyJamSessionStarted(otherId, userId, starterName, chatId).catch((error) => {
          console.error('Failed to send jam session started notification:', error)
        })
      }
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

    const leaverId = req.user!.id
    await endSession(id)
    await notifyOtherMember(session.chat_id, leaverId, 'jam:session:ended', { sessionId: id })

    // Persisted + push notification to BOTH participants (the live socket
    // event above only reaches an already-open app, and only the other
    // member). The leaver doesn't need a push for their own action, but
    // still gets an in-app notification record (see `push` flag in
    // notifyJamSessionLeft).
    const otherId = await getOtherChatMemberId(session.chat_id, leaverId)
    getUserDisplayName(leaverId).then((leaverName) => {
      NotificationService.notifyJamSessionLeft(leaverId, leaverId, leaverName, session.chat_id).catch((error) => {
        console.error('Failed to send jam session left (self) notification:', error)
      })
      if (otherId) {
        NotificationService.notifyJamSessionLeft(otherId, leaverId, leaverName, session.chat_id).catch((error) => {
          console.error('Failed to send jam session left notification:', error)
        })
      }
    }).catch((error) => {
      console.error('Failed to look up leaver name for jam session left notification:', error)
    })

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

// --- Playlists: scoped to the CHAT (the pair of users), not a single owner -- both
// chat members can create/edit/reorder/delete these mutually, same as they mutually
// control the jam session's own queue. Independent of a session's own lifecycle (see
// jam_playlists' migration comment) -- ending a jam session must never delete these. ---

router.get('/playlists', requireAuth, async (req: AuthRequest, res) => {
  try {
    const chatId = String(req.query.chatId ?? '')
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    if (!(await requireMembership(req, res, chatId))) return
    const playlists = await getPlaylistsForChat(chatId)
    res.json({ playlists })
  } catch (error) {
    console.error('Get playlists error:', error)
    res.status(500).json({ error: 'Failed to load playlists' })
  }
})

router.post('/playlists', requireAuth, async (req: AuthRequest, res) => {
  try {
    const chatId = String(req.body?.chatId ?? '')
    const name = String(req.body?.name || '').trim()
    if (!chatId) return res.status(400).json({ error: 'chatId is required' })
    if (!name) return res.status(400).json({ error: 'name is required' })
    if (!(await requireMembership(req, res, chatId))) return
    const playlist = await createPlaylist(chatId, req.user!.id, name)
    res.status(201).json({ playlist })
  } catch (error) {
    console.error('Create playlist error:', error)
    res.status(500).json({ error: 'Failed to create playlist' })
  }
})

/** Any member of the playlist's chat may view/edit/reorder/delete it -- these are shared
 * between the two participants, not gated by who happened to create it. */
async function requirePlaylistAccess(req: AuthRequest, res: any, playlistId: string) {
  const playlist = await getPlaylist(playlistId)
  if (!playlist) {
    res.status(404).json({ error: 'Playlist not found' })
    return null
  }
  if (!(await requireMembership(req, res, playlist.chat_id))) return null
  return playlist
}

router.get('/playlists/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const playlist = await requirePlaylistAccess(req, res, req.params.id)
    if (!playlist) return
    const tracks = await getPlaylistTracks(playlist.id)
    res.json({ playlist, tracks })
  } catch (error) {
    console.error('Get playlist error:', error)
    res.status(500).json({ error: 'Failed to load playlist' })
  }
})

router.put('/playlists/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const playlist = await requirePlaylistAccess(req, res, req.params.id)
    if (!playlist) return
    const name = String(req.body?.name || '').trim()
    if (!name) return res.status(400).json({ error: 'name is required' })
    await renamePlaylist(playlist.id, name)
    res.json({ ok: true })
  } catch (error) {
    console.error('Rename playlist error:', error)
    res.status(500).json({ error: 'Failed to rename playlist' })
  }
})

router.delete('/playlists/:id', requireAuth, async (req: AuthRequest, res) => {
  try {
    const playlist = await requirePlaylistAccess(req, res, req.params.id)
    if (!playlist) return
    await deletePlaylist(playlist.id)
    res.json({ ok: true })
  } catch (error) {
    console.error('Delete playlist error:', error)
    res.status(500).json({ error: 'Failed to delete playlist' })
  }
})

router.post('/playlists/:id/tracks', requireAuth, async (req: AuthRequest, res) => {
  try {
    const playlist = await requirePlaylistAccess(req, res, req.params.id)
    if (!playlist) return
    const { videoId, title, channelTitle, thumbnailUrl, durationSeconds } = req.body
    if (!videoId || !title) return res.status(400).json({ error: 'videoId and title are required' })
    const track = await addPlaylistTrack({
      playlistId: playlist.id, youtubeVideoId: videoId, title, channelTitle, thumbnailUrl, durationSeconds, addedBy: req.user!.id,
    })
    res.status(201).json({ track })
  } catch (error) {
    console.error('Add playlist track error:', error)
    res.status(500).json({ error: 'Failed to add track to playlist' })
  }
})

router.delete('/playlists/:id/tracks/:trackId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const playlist = await requirePlaylistAccess(req, res, req.params.id)
    if (!playlist) return
    await removePlaylistTrack(playlist.id, req.params.trackId)
    res.json({ ok: true })
  } catch (error) {
    console.error('Remove playlist track error:', error)
    res.status(500).json({ error: 'Failed to remove track from playlist' })
  }
})

// Rewrites the whole track order -- either participant can reorder it, not gated by who
// added which track (mutual editing is the whole point of a shared playlist).
router.put('/playlists/:id/tracks/order', requireAuth, async (req: AuthRequest, res) => {
  try {
    const playlist = await requirePlaylistAccess(req, res, req.params.id)
    if (!playlist) return
    const trackIds = Array.isArray(req.body?.trackIds) ? req.body.trackIds.map(String) : []
    if (!trackIds.length) return res.status(400).json({ error: 'trackIds is required' })
    await reorderPlaylistTracks(playlist.id, trackIds)
    const tracks = await getPlaylistTracks(playlist.id)
    res.json({ tracks })
  } catch (error) {
    console.error('Reorder playlist tracks error:', error)
    res.status(500).json({ error: 'Failed to reorder playlist' })
  }
})

// Loads a saved playlist's tracks into a live jam session's queue, in order or
// shuffled, and -- mirroring POST /sessions/:id/queue -- starts the first one
// playing immediately if nothing is currently cued.
router.post('/sessions/:id/playlist/:playlistId/load', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id, playlistId } = req.params
    const userId = req.user!.id
    const mode = req.body?.mode === 'shuffle' ? 'shuffle' : 'sequence'

    const session = await getSession(id)
    if (!session) return res.status(404).json({ error: 'Session not found' })
    if (!(await requireMembership(req, res, session.chat_id))) return

    const playlist = await getPlaylist(playlistId)
    if (!playlist || playlist.chat_id !== session.chat_id) return res.status(404).json({ error: 'Playlist not found' })
    const tracks = await getPlaylistTracks(playlistId)
    if (!tracks.length) return res.status(400).json({ error: 'Playlist is empty' })

    const ordered = mode === 'shuffle' ? shuffle(tracks) : tracks

    let firstAdded: Awaited<ReturnType<typeof addToQueue>> | null = null
    for (const t of ordered) {
      const item = await addToQueue({
        sessionId: id,
        youtubeVideoId: t.youtube_video_id,
        title: t.title,
        channelTitle: t.channel_title,
        thumbnailUrl: t.thumbnail_url,
        durationSeconds: t.duration_seconds,
        addedBy: userId,
      })
      if (!firstAdded) firstAdded = item
    }

    let updatedSession = session
    let becameCurrent = false
    if (!session.current_queue_item_id && firstAdded) {
      await markQueueItemStatus(firstAdded.id, 'playing')
      await setCurrentTrack(id, firstAdded.id)
      await setPlaybackState(id, { isPlaying: true })
      updatedSession = (await getSession(id))!
      becameCurrent = true
    }

    const queue = await getQueueForSession(id)
    const room = `chat:${session.chat_id}`
    emitToRoom(room, 'jam:queue:updated', { sessionId: id, queue })
    if (becameCurrent && firstAdded) {
      emitToRoom(room, 'jam:playback:track_changed', { sessionId: id, queueItem: firstAdded, positionMs: 0 })
    }
    res.status(201).json({ queue, session: updatedSession, becameCurrent })
  } catch (error) {
    console.error('Load playlist into jam session error:', error)
    res.status(500).json({ error: 'Failed to load playlist' })
  }
})

/** Fisher-Yates -- in-place shuffle would mutate the caller's array, so this copies first. */
function shuffle<T>(items: T[]): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

export default router
