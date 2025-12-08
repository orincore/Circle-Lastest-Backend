import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { PromptMatchingService } from '../services/prompt-matching.service.js'
import { supabase } from '../config/supabase.js'
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
    const { data: givers, error } = await supabase
      .from('giver_profiles')
      .select(`
        user_id,
        is_available,
        total_helps_given,
        average_rating,
        skills,
        categories,
        profiles!inner(username, first_name, about, interests)
      `)
      .eq('is_available', true)

    if (error) {
      throw error
    }

    res.json({
      count: givers?.length || 0,
      givers: givers?.map((g: any) => ({
        userId: g.user_id,
        username: g.profiles?.username,
        firstName: g.profiles?.first_name,
        about: g.profiles?.about,
        interests: g.profiles?.interests,
        skills: g.skills,
        categories: g.categories,
        totalHelps: g.total_helps_given,
        rating: g.average_rating
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
    const { data: matches, error } = await supabase.rpc('find_best_giver_match', {
      p_prompt_embedding: JSON.stringify(promptEmbedding),
      p_receiver_user_id: receiverUserId || req.user!.id,
      p_excluded_giver_ids: [],
      p_limit: 5 // Get top 5 matches for debugging
    })

    if (error) {
      throw error
    }

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
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('about, interests, needs')
      .eq('id', userId)
      .single()

    if (profileError) {
      throw profileError
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
