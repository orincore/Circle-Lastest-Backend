import { logger } from '../config/logger.js'

interface UserPreferences {
  max_distance?: number
  age_range?: [number, number]
  interests?: string[]
  needs?: string[]
  gender_preference?: string
}

interface MatchRequest {
  user_id: string
  prompt?: string
  preferences?: UserPreferences
  latitude?: number
  longitude?: number
  limit?: number
  single_best_match?: boolean
  candidate_ids?: string[]
  exclude_user_ids?: string[]
}

interface UserProfile {
  id: string
  name: string
  age?: number
  bio?: string
  interests?: string[]
  needs?: string[]
  latitude?: number
  longitude?: number
  gender?: string
  match_score: number
}

interface MatchResponse {
  success: boolean
  matches: UserProfile[]
  total_candidates: number
  processing_time_ms: number
}

export class MLMatchingService {
  private static readonly ML_SERVICE_URL = process.env.ML_SERVICE_URL || 'http://ml-matching:8090'
  private static readonly INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'Orincore7094'
  private static readonly TIMEOUT_MS = 30000

  static async findMatches(request: MatchRequest): Promise<MatchResponse> {
    try {
      const startTime = Date.now()

      const response = await fetch(`${this.ML_SERVICE_URL}/api/ml/match`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this.INTERNAL_API_KEY,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.TIMEOUT_MS),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`ML service error: ${response.status} - ${errorText}`)
      }

      const data = await response.json() as MatchResponse
      const totalTime = Date.now() - startTime

      logger.info({
        msg: `ML matching completed for user ${request.user_id}`,
        matches_found: data.matches.length,
        total_candidates: data.total_candidates,
        ml_processing_time: data.processing_time_ms,
        total_time: totalTime,
      })

      return data
    } catch (error) {
      logger.error({
        msg: 'Error calling ML matching service',
        error: error instanceof Error ? error.message : String(error),
        user_id: request.user_id,
      })

      return {
        success: false,
        matches: [],
        total_candidates: 0,
        processing_time_ms: 0,
      }
    }
  }

  static async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ML_SERVICE_URL}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })

      return response.ok
    } catch (error) {
      logger.error({
        msg: 'ML service health check failed',
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  }

  static async findPromptBasedMatches(
    userId: string,
    prompt: string,
    options?: {
      latitude?: number
      longitude?: number
      maxDistance?: number
      ageRange?: [number, number]
      limit?: number
    }
  ): Promise<UserProfile[]> {
    const request: MatchRequest = {
      user_id: userId,
      prompt,
      latitude: options?.latitude,
      longitude: options?.longitude,
      limit: options?.limit || 10,
      preferences: {
        max_distance: options?.maxDistance,
        age_range: options?.ageRange,
      },
    }

    const response = await this.findMatches(request)
    return response.matches
  }

  static async findSingleBestMatch(
    userId: string,
    prompt: string,
    options?: {
      latitude?: number
      longitude?: number
      maxDistance?: number
      ageRange?: [number, number]
      candidateIds?: string[]
      excludeUserIds?: string[]
    }
  ): Promise<UserProfile | null> {
    const request: MatchRequest = {
      user_id: userId,
      prompt,
      latitude: options?.latitude,
      longitude: options?.longitude,
      limit: 1,
      single_best_match: true,
      candidate_ids: options?.candidateIds,
      exclude_user_ids: options?.excludeUserIds,
      preferences: {
        max_distance: options?.maxDistance,
        age_range: options?.ageRange,
      },
    }

    const response = await this.findMatches(request)
    return response.matches?.[0] || null
  }

  static async findPreferenceBasedMatches(
    userId: string,
    preferences: UserPreferences,
    location?: { latitude: number; longitude: number },
    limit: number = 10
  ): Promise<UserProfile[]> {
    const request: MatchRequest = {
      user_id: userId,
      preferences,
      latitude: location?.latitude,
      longitude: location?.longitude,
      limit,
    }

    const response = await this.findMatches(request)
    return response.matches
  }
}
