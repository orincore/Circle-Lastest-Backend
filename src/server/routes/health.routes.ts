import { Router } from 'express'

const router = Router()
router.get('/', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() })
})

export default router
