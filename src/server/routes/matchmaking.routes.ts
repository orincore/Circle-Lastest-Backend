import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { startSearch, getStatus, decide, cancelSearch } from '../services/matchmaking.js'

const router = Router()

// Start matchmaking search
router.post('/start', requireAuth, async (req: AuthRequest, res) => {
  await startSearch(req.user!.id)
  res.json({ ok: true })
})

// Cancel matchmaking search (optional)
router.post('/cancel', requireAuth, async (req: AuthRequest, res) => {
  await cancelSearch(req.user!.id)
  res.json({ ok: true })
})

// Get current matchmaking status
router.get('/status', requireAuth, async (req: AuthRequest, res) => {
  const status = await getStatus(req.user!.id)
  res.json(status)
})

// Decide on a proposal: accept or pass
router.post('/decide', requireAuth, async (req: AuthRequest, res) => {
  const d = String(req.body?.decision || '')
  if (d !== 'accept' && d !== 'pass') return res.status(400).json({ error: 'Invalid decision' })
  const status = await decide(req.user!.id, d as 'accept' | 'pass')
  res.json(status)
})

export default router
