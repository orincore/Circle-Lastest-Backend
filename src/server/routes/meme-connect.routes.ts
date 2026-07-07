import { Router } from 'express'
import { requireAuth, AuthRequest } from '../middleware/auth.js'
import {
  createConnectRequestFromComment,
  listConnectRequests,
  respondToConnectRequest,
  requestReveal,
  DuplicateRequestError,
  NotFoundError,
  ForbiddenError,
} from '../services/memeConnect.service.js'
import { getBlurredAvatarDataUri } from '../services/anonAvatar.service.js'
const router = Router()

const requestToJson = (r: any) => ({
  id: r.id,
  requester_id: r.requesterId,
  target_id: r.targetId,
  context_meme_id: r.contextMemeId,
  status: r.status,
  chat_id: r.chatId,
  requester_revealed: r.requesterRevealed,
  target_revealed: r.targetRevealed,
  revealed_at: r.revealedAt,
  created_at: r.createdAt,
  responded_at: r.respondedAt,
})

// POST /api/feed/connect-requests -- request to connect with whoever wrote a comment.
// Takes comment_id, NOT a user id: the comments API never returns the commenter's real
// user_id (only their alias), so the client can never legitimately supply one. The
// target user and the meme it happened under are resolved server-side from the comment.
router.post('/connect-requests', requireAuth, async (req: AuthRequest, res) => {
  try {
    const requesterId = req.user!.id
    const { comment_id } = req.body || {}

    if (!comment_id || typeof comment_id !== 'string') {
      return res.status(400).json({ error: 'comment_id is required' })
    }

    const row = await createConnectRequestFromComment(requesterId, comment_id)
    return res.json({ request: requestToJson(row) })
  } catch (e) {
    if (e instanceof NotFoundError) return res.status(404).json({ error: e.message })
    if (e instanceof ForbiddenError) return res.status(400).json({ error: e.message })
    if (e instanceof DuplicateRequestError) return res.status(409).json({ error: e.message })
    console.error('create connect request error:', e)
    return res.status(500).json({ error: 'Failed to create connect request' })
  }
})

// The chat/share-picker UI shows a blurred version of the *other* party's
// real profile photo for these still-anonymous connections (same
// server-side blur as comment avatars -- see anonAvatar.service.ts). Which
// side is "the other party" depends on whether this viewer is the requester
// or the target, so it's resolved here rather than in the stateless
// `requestToJson` helper.
async function withOtherPartyAvatar(rows: ReturnType<typeof requestToJson>[], otherIdKey: 'requester_id' | 'target_id') {
  return Promise.all(rows.map(async (r) => ({ ...r, avatar: await getBlurredAvatarDataUri(r[otherIdKey]) })))
}

router.get('/connect-requests', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { incoming, outgoing } = await listConnectRequests(req.user!.id)
    const [incomingJson, outgoingJson] = await Promise.all([
      withOtherPartyAvatar(incoming.map(requestToJson), 'requester_id'),
      withOtherPartyAvatar(outgoing.map(requestToJson), 'target_id'),
    ])
    return res.json({ incoming: incomingJson, outgoing: outgoingJson })
  } catch (e) {
    console.error('list connect requests error:', e)
    return res.status(500).json({ error: 'Failed to list connect requests' })
  }
})

router.post('/connect-requests/:id/respond', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const { accept } = req.body || {}

    if (typeof accept !== 'boolean') {
      return res.status(400).json({ error: 'accept (boolean) is required' })
    }

    const row = await respondToConnectRequest(id, req.user!.id, accept)
    return res.json({ request: requestToJson(row) })
  } catch (e) {
    if (e instanceof NotFoundError) return res.status(404).json({ error: e.message })
    if (e instanceof ForbiddenError) return res.status(403).json({ error: e.message })
    console.error('respond connect request error:', e)
    return res.status(500).json({ error: 'Failed to respond to connect request' })
  }
})

router.post('/connect-requests/:id/reveal', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { id } = req.params
    const row = await requestReveal(id, req.user!.id)
    return res.json({ request: requestToJson(row) })
  } catch (e) {
    if (e instanceof NotFoundError) return res.status(404).json({ error: e.message })
    if (e instanceof ForbiddenError) return res.status(403).json({ error: e.message })
    console.error('reveal connect request error:', e)
    return res.status(500).json({ error: 'Failed to request reveal' })
  }
})

export default router
