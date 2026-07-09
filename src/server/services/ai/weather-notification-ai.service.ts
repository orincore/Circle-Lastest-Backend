import { logger } from '../../config/logger.js'
import type { WeatherCondition } from '../weatherService.js'

/**
 * Generates fresh, varied push-notification copy for the weather check-in
 * engagement feature, instead of always sending the same fixed sentence per
 * condition. Uses gpt-5-nano -- same "cheapest chat model, no reasoning
 * needed" choice already made for bio generation (ai-support.routes.ts) and
 * personal-info moderation (content-filter.service.ts) -- since this is a
 * short, low-stakes copywriting task, not something that needs a bigger
 * model's reasoning.
 *
 * The model is asked to write with the LITERAL placeholders {name} and
 * {area} left in place (rather than being given the real name/area), so one
 * generated line can be reused -- and cheaply cached per condition for the
 * whole run -- across every affected user/friend pair that shares the same
 * weather condition that day, instead of one API call per notification.
 */

const API_BASE_URL = 'https://api.openai.com/v1'
const MODEL = 'gpt-5-nano'

function getApiKey(): string | null {
  return process.env.OPENAI_API_KEY || null
}

export interface WeatherNotificationCopy {
  title: string
  body: string
}

const SYSTEM_PROMPT = `You write short, fun push notification copy for a social app called Circle.

IMPORTANT -- who is who: the person reading this notification is NOT {name}. {name} is that
reader's friend, who is currently experiencing the weather condition below. The reader is
somewhere else and is being nudged to check in on {name}. Never address {name} directly (no
"Hey {name}, ...", no "near you" meaning {name}'s location as if {name} is reading this) -- always
write in third person about {name} ("it's snowing near {name}", "check in on {name}"), speaking
TO the reader.

Given a weather condition currently happening near {name}, write:
- A short title (max 6 words, include exactly one relevant emoji)
- A one-sentence body (max 22 words)

Both should encourage the reader to check in on {name} or say hi to them, matching the mood of
the weather: warm/concerned tone for stormy, rainy, or snowy conditions; cheerful/casual tone for
sunny, cloudy, or windy conditions.

Use the LITERAL placeholder tokens {name} (the friend's first name) and {area} (their city) exactly
as written wherever a name or location would go -- do not invent a name or place, just use the tokens.

Output EXACTLY two lines, nothing else, in this format:
TITLE: <title text>
BODY: <body text>`

/**
 * Returns null (never throws) on any failure -- callers must fall back to
 * static copy so an OpenAI outage or missing API key never blocks the
 * notification pipeline.
 */
export async function generateWeatherNotificationCopy(condition: WeatherCondition): Promise<WeatherNotificationCopy | null> {
  const apiKey = getApiKey()
  if (!apiKey) return null

  try {
    const response = await fetch(`${API_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Weather condition: ${condition}` },
        ],
        // gpt-5-nano only supports the default temperature (1) -- passing
        // any other value 400s, so it's omitted (matches the other two
        // gpt-5-nano call sites in this codebase).
        max_completion_tokens: 120,
        // Without this, gpt-5-nano spends the whole token budget on hidden
        // reasoning tokens and returns empty visible content. This is a
        // trivial copywriting task, so minimal leaves the budget for output.
        reasoning_effort: 'minimal',
        stream: false,
      }),
    })

    if (!response.ok) {
      logger.warn({ status: response.status }, '[weather-notification-ai] OpenAI request failed, falling back to static copy')
      return null
    }

    const data = await response.json()
    const text: string = data.choices?.[0]?.message?.content || ''

    const titleMatch = text.match(/^TITLE:\s*(.+)$/m)
    const bodyMatch = text.match(/^BODY:\s*(.+)$/m)
    if (!titleMatch || !bodyMatch) {
      logger.warn({ text }, '[weather-notification-ai] Unparseable AI response, falling back to static copy')
      return null
    }

    const title = titleMatch[1].trim()
    const body = bodyMatch[1].trim()
    if (!title || !body) return null

    return { title, body }
  } catch (error) {
    logger.warn({ error }, '[weather-notification-ai] Failed to generate weather notification copy, falling back to static copy')
    return null
  }
}
