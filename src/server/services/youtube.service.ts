import { env } from '../config/env.js'
import { cache } from './cache.js'

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3'
const SEARCH_CACHE_TTL_SECONDS = 6 * 60 * 60 // repeated song searches across users are highly duplicated
const MUSIC_CATEGORY_ID = '10'

export interface YoutubeSearchResult {
  videoId: string
  title: string
  channelTitle: string
  thumbnailUrl: string | null
  durationSeconds: number | null
}

/** "PT3M42S" -> 222. Returns null for live streams (no fixed duration) or malformed input. */
function parseIsoDurationToSeconds(iso: string | undefined): number | null {
  if (!iso) return null
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso)
  if (!match) return null
  const [, h, m, s] = match
  const seconds = (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(s) || 0)
  return seconds || null
}

/** Strips noise like "(Official Video)", "[Lyrics]", "ft. X" so a finished track's title makes a decent search seed. */
export function deriveSearchSeedFromTitle(title: string): string {
  return title
    .replace(/[\(\[][^)\]]*(official|video|audio|lyrics|lyric|hd|4k|visualizer)[^)\]]*[\)\]]/gi, '')
    .replace(/\b(ft\.?|feat\.?|featuring)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function requireApiKey(): string {
  if (!env.YOUTUBE_API_KEY) {
    const e: any = new Error('YouTube search is not configured (missing YOUTUBE_API_KEY)')
    e.status = 503
    throw e
  }
  return env.YOUTUBE_API_KEY
}

async function fetchDurations(apiKey: string, videoIds: string[]): Promise<Map<string, number | null>> {
  const durations = new Map<string, number | null>()
  if (!videoIds.length) return durations

  const url = new URL(`${YOUTUBE_API_BASE}/videos`)
  url.searchParams.set('part', 'contentDetails')
  url.searchParams.set('id', videoIds.join(','))
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  if (!res.ok) return durations // best-effort — search still works without durations
  const data = await res.json()
  for (const item of data.items ?? []) {
    durations.set(item.id, parseIsoDurationToSeconds(item.contentDetails?.duration))
  }
  return durations
}

/** Searches YouTube for embeddable videos matching `query`. Server-side only — the API key never reaches the client. */
export async function searchYoutube(query: string, opts: { musicOnly?: boolean } = {}): Promise<YoutubeSearchResult[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const cacheKey = `jam:yt:search:${opts.musicOnly ? 'music:' : ''}${trimmed.toLowerCase()}`
  const cached = await cache.getJSON<YoutubeSearchResult[]>(cacheKey)
  if (cached) return cached

  const apiKey = requireApiKey()

  const url = new URL(`${YOUTUBE_API_BASE}/search`)
  url.searchParams.set('part', 'snippet')
  url.searchParams.set('type', 'video')
  url.searchParams.set('videoEmbeddable', 'true')
  url.searchParams.set('maxResults', '15')
  url.searchParams.set('q', trimmed)
  if (opts.musicOnly) url.searchParams.set('videoCategoryId', MUSIC_CATEGORY_ID)
  url.searchParams.set('key', apiKey)

  const res = await fetch(url.toString())
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const e: any = new Error(`YouTube search failed (${res.status}): ${body}`)
    e.status = res.status === 403 ? 429 : 502 // 403 from YouTube usually means quota exhausted
    throw e
  }
  const data = await res.json()
  const items = (data.items ?? []) as any[]
  const videoIds = items.map((i) => i.id?.videoId).filter(Boolean)
  const durations = await fetchDurations(apiKey, videoIds)

  const results: YoutubeSearchResult[] = items
    .filter((i) => i.id?.videoId)
    .map((i) => ({
      videoId: i.id.videoId,
      title: i.snippet?.title ?? 'Untitled',
      channelTitle: i.snippet?.channelTitle ?? '',
      thumbnailUrl: i.snippet?.thumbnails?.medium?.url ?? i.snippet?.thumbnails?.default?.url ?? null,
      durationSeconds: durations.get(i.id.videoId) ?? null,
    }))

  await cache.setJSON(cacheKey, results, SEARCH_CACHE_TTL_SECONDS)
  return results
}

/**
 * Approximates "related videos" (YouTube Data API v3 removed `relatedToVideoId` in 2023).
 * Searches on the finished track's title/channel, excluding anything already in the queue.
 */
export async function findRecommendation(
  finishedTrack: { title: string; channelTitle: string | null },
  excludeVideoIds: string[]
): Promise<YoutubeSearchResult | null> {
  const seed = deriveSearchSeedFromTitle(finishedTrack.title)
  const query = [seed, finishedTrack.channelTitle].filter(Boolean).join(' ')
  if (!query.trim()) return null

  const results = await searchYoutube(query, { musicOnly: true })
  const exclude = new Set(excludeVideoIds)
  return results.find((r) => !exclude.has(r.videoId)) ?? null
}
