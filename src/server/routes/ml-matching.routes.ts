import { Router, Response } from 'express'
import { MLMatchingService } from '../services/ml-matching.service.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { logger } from '../config/logger.js'

const router = Router()

router.post('/search', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const {
      prompt,
      preferences,
      latitude,
      longitude,
      limit = 10,
    } = req.body

    if (!prompt && !preferences) {
      return res.status(400).json({
        error: 'Either prompt or preferences must be provided',
      })
    }

    const matches = await MLMatchingService.findMatches({
      user_id: userId,
      prompt,
      preferences,
      latitude,
      longitude,
      limit,
    })

    return res.json({
      success: true,
      matches: matches.matches,
      total_candidates: matches.total_candidates,
      processing_time_ms: matches.processing_time_ms,
    })
  } catch (error) {
    logger.error({
      msg: 'Error in ML matching search',
      error: error instanceof Error ? error.message : String(error),
      user_id: req.user?.id,
    })

    return res.status(500).json({
      error: 'Failed to search for matches',
      success: false,
    })
  }
})

router.post('/prompt-search', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { prompt, latitude, longitude, max_distance, age_range, limit } = req.body

    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({
        error: 'Valid prompt is required',
      })
    }

    const matches = await MLMatchingService.findPromptBasedMatches(
      userId,
      prompt.trim(),
      {
        latitude,
        longitude,
        maxDistance: max_distance,
        ageRange: age_range,
        limit,
      }
    )

    return res.json({
      success: true,
      matches,
      count: matches.length,
    })
  } catch (error) {
    logger.error({
      msg: 'Error in prompt-based matching',
      error: error instanceof Error ? error.message : String(error),
      user_id: req.user?.id,
    })

    return res.status(500).json({
      error: 'Failed to find matches',
      success: false,
    })
  }
})

router.get('/health', async (_req: AuthRequest, res: Response) => {
  try {
    const isHealthy = await MLMatchingService.healthCheck()

    return res.json({
      service: 'ml-matching',
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    return res.status(503).json({
      service: 'ml-matching',
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    })
  }
})

export default router
