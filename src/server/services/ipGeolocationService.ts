import { Redis } from 'ioredis'
import { logger } from '../config/logger.js'

/**
 * Resolves a public IP to an approximate city-level location, for two
 * consumers: the Active Sessions list (showing roughly where a login came
 * from) and the weather-checkin engagement feature's fallback location
 * source when a user hasn't granted GPS permission. Same fallback-chain
 * shape as weatherService.ts -- try each free/keyless provider in order,
 * never throw, resolve to null if every provider fails or the IP is
 * private/local, so callers can just skip that IP for this run.
 *
 * IP-derived coordinates are inherently coarse (city-grade, sometimes wrong
 * for VPNs/mobile carrier NAT) and must only ever be used ephemerally --
 * never written into profiles.latitude/longitude, which other features rely
 * on being precise GPS data.
 */

export interface IpLocationResult {
  lat: number
  lon: number
  city: string
  country: string
}

const FETCH_TIMEOUT_MS = 5000
const CACHE_TTL_SECONDS = 6 * 60 * 60 // 6 hours -- plenty fresh for city-level location, keeps free-tier providers well under their rate limits

// Dedicated lazyConnect client, same self-contained pattern as the other
// Redis clients added this session (blind-dating.service.ts's lockRedis,
// engagement-notifications-scheduler.ts's lockRedis) -- never opens a
// connection just from being imported, and a Redis outage degrades this
// service to "no caching" rather than breaking it (see getLocationFromIp's
// try/catch around cache reads/writes below).
const geoRedis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 2,
  lazyConnect: true,
})
geoRedis.on('error', (err) => {
  logger.error({ err }, 'IP geolocation Redis client error')
})

function cacheKey(ip: string): string {
  return `geoip:${ip}`
}

// RFC1918 private ranges, loopback, and link-local/unique-local IPv6 --
// never worth a network call, and these show up constantly in local/dev
// testing and internal traffic.
const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,
  /^fe80:/i,
]

// Node returns IPv4-mapped IPv6 addresses (e.g. "::ffff:192.168.0.124") for
// IPv4 connections whenever the server is listening on both stacks and
// there's no reverse proxy stripping this down to a bare IPv4 string --
// strip the prefix so every check/lookup/cache-key below sees the plain
// IPv4 form. Without this, e.g. "::ffff:192.168.0.124" doesn't match any
// PRIVATE_IP_PATTERNS above (they're all written for bare IPv4/IPv6), so a
// private LAN address slips past the private-IP check and gets sent
// straight to the external geo providers -- which then fail to resolve it,
// silently producing the same "no location" result as a real bug, not by
// deliberate design. The same mapping can just as easily wrap a genuine
// public IPv4 address, so normalizing here also fixes lookups for those.
export function normalizeIp(ip: string): string {
  return ip.replace(/^::ffff:/i, '')
}

function isPrivateOrLoopback(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip))
}

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<any> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchIpapiCo(ip: string): Promise<IpLocationResult> {
  const data = await fetchWithTimeout(`https://ipapi.co/${ip}/json/`)
  if (data?.error) throw new Error(`ipapi.co error: ${data.reason || 'unknown'}`)
  if (typeof data?.latitude !== 'number' || typeof data?.longitude !== 'number') {
    throw new Error('ipapi.co response missing latitude/longitude')
  }
  return {
    lat: data.latitude,
    lon: data.longitude,
    city: data.city || '',
    country: data.country_code || data.country || '',
  }
}

async function fetchIpApiCom(ip: string): Promise<IpLocationResult> {
  // Free tier is HTTP-only (no HTTPS) -- acceptable here since this call
  // carries no user secrets, just an IP address that's already server-side.
  const data = await fetchWithTimeout(`http://ip-api.com/json/${ip}?fields=status,message,country,countryCode,city,lat,lon`)
  if (data?.status !== 'success') throw new Error(`ip-api.com error: ${data?.message || 'unknown'}`)
  if (typeof data?.lat !== 'number' || typeof data?.lon !== 'number') {
    throw new Error('ip-api.com response missing lat/lon')
  }
  return {
    lat: data.lat,
    lon: data.lon,
    city: data.city || '',
    country: data.countryCode || data.country || '',
  }
}

const PROVIDERS = [fetchIpapiCo, fetchIpApiCom]

/**
 * Resolves an IP to an approximate location. Never throws -- returns null
 * for private/loopback IPs (no network call attempted), or if every
 * provider fails.
 */
export async function getLocationFromIp(ip: string | null | undefined): Promise<IpLocationResult | null> {
  if (!ip) return null
  const normalized = normalizeIp(ip)
  if (isPrivateOrLoopback(normalized)) return null

  try {
    const cached = await geoRedis.get(cacheKey(normalized))
    if (cached) return JSON.parse(cached) as IpLocationResult
  } catch (error) {
    logger.debug({ error, ip: normalized }, '[ip-geolocation] cache read failed, proceeding without cache')
  }

  for (const provider of PROVIDERS) {
    try {
      const result = await provider(normalized)
      try {
        await geoRedis.set(cacheKey(normalized), JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
      } catch (error) {
        logger.debug({ error, ip: normalized }, '[ip-geolocation] cache write failed, continuing without cache')
      }
      return result
    } catch (error) {
      logger.debug({ error, provider: provider.name, ip: normalized }, '[ip-geolocation] provider failed, trying next')
    }
  }

  return null
}
