import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { PromptMatchingService } from '../services/prompt-matching.service.js'
import { eq, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { giverProfiles, profiles } from '../db/schema.js'
import { logger } from '../config/logger.js'

const router = Router()

/**
 * DEBUG: Test embedding generation
 */
router.post('/test-embedding', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { text } = req.body
    
    if (!text) {
      return res.status(400).json({ error: 'Text is required' })
    }

    // Generate embedding using the private method (for testing)
    const embedding = await (PromptMatchingService as any).generateEmbedding(text)
    
    res.json({
      text,
      embeddingLength: embedding.length,
      embeddingMagnitude: Math.sqrt(embedding.reduce((sum: number, val: number) => sum + val * val, 0)),
      sampleValues: embedding.slice(0, 10) // First 10 values for inspection
    })
  } catch (error) {
    logger.error({ error }, 'Error testing embedding generation')
    res.status(500).json({ error: 'Failed to generate embedding' })
  }
})

/**
 * DEBUG: Check available givers
 */
router.get('/available-givers', requireAuth, async (req: AuthRequest, res) => {
  try {
    const givers = await db.select({
      userId: giverProfiles.userId,
      isAvailable: giverProfiles.isAvailable,
      totalHelpsGiven: giverProfiles.totalHelpsGiven,
      averageRating: giverProfiles.averageRating,
      skills: giverProfiles.skills,
      categories: giverProfiles.categories,
      username: profiles.username,
      firstName: profiles.firstName,
      about: profiles.about,
      interests: profiles.interests,
    })
      .from(giverProfiles)
      .innerJoin(profiles, eq(profiles.id, giverProfiles.userId))
      .where(eq(giverProfiles.isAvailable, true))

    res.json({
      count: givers.length,
      givers: givers.map(g => ({
        userId: g.userId,
        username: g.username,
        firstName: g.firstName,
        about: g.about,
        interests: g.interests,
        skills: g.skills,
        categories: g.categories,
        totalHelps: g.totalHelpsGiven,
        rating: Number(g.averageRating ?? 0)
      }))
    })
  } catch (error) {
    logger.error({ error }, 'Error fetching available givers')
    res.status(500).json({ error: 'Failed to fetch givers' })
  }
})

/**
 * DEBUG: Test matching algorithm
 */
router.post('/test-match', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { prompt, receiverUserId } = req.body
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' })
    }

    // Generate embedding for the prompt
    const promptEmbedding = await (PromptMatchingService as any).generateEmbedding(prompt)
    
    // Test the matching function
    const matchResult: any = await db.execute(sql`
      select * from find_best_giver_match(
        ${JSON.stringify(promptEmbedding)}::vector,
        ${receiverUserId || req.user!.id}::uuid,
        ${'{}'}::uuid[],
        5
      )
    `)
    const matches = matchResult.rows

    res.json({
      prompt,
      promptEmbedding: {
        length: promptEmbedding.length,
        magnitude: Math.sqrt(promptEmbedding.reduce((sum: number, val: number) => sum + val * val, 0)),
        sample: promptEmbedding.slice(0, 10)
      },
      matches: matches || [],
      matchCount: matches?.length || 0
    })
  } catch (error) {
    logger.error({ error }, 'Error testing match algorithm')
    res.status(500).json({ error: 'Failed to test matching' })
  }
})

/**
 * DEBUG: Force refresh giver profile
 */
router.post('/refresh-giver-profile/:userId', requireAuth, async (req: AuthRequest, res) => {
  try {
    const { userId } = req.params
    
    // Get current profile data
    const [profile] = await db.select({ about: profiles.about, interests: profiles.interests, needs: profiles.needs })
      .from(profiles).where(eq(profiles.id, userId)).limit(1)

    if (!profile) {
      throw new Error(`Profile not found for user ${userId}`)
    }

    // Update giver profile with fresh embedding
    const result = await PromptMatchingService.createOrUpdateGiverProfile(
      userId,
      [], // skills
      []  // categories
    )

    res.json({
      userId,
      profileData: profile,
      result,
      message: 'Giver profile refreshed successfully'
    })
  } catch (error) {
    logger.error({ error }, 'Error refreshing giver profile')
    res.status(500).json({ error: 'Failed to refresh giver profile' })
  }
})

export default router
