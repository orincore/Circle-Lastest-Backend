import { logger } from '../config/logger.js'

/**
 * Backend port of CircleReact/src/api/weather.js + src/utils/weatherMapping.js.
 * Same three keyless providers, same fallback order, same condition
 * vocabulary ('sunny'|'cloudy'|'rainy'|'snow'|'stormy'|'windy') -- kept in
 * sync deliberately so "the weather" means the same thing on both ends. No
 * API key needed for any of the three providers.
 */

export type WeatherCondition = 'sunny' | 'cloudy' | 'rainy' | 'snow' | 'stormy' | 'windy'

export interface WeatherResult {
  condition: WeatherCondition
  isDay: boolean
  tempC?: number
  /** True for genuinely heavy/severe conditions worth interrupting a friend over -- not light drizzle. */
  isSevere: boolean
}

const FETCH_TIMEOUT_MS = 6000
const WINDY_WIND_SPEED_KMH = 30
const WINDY_WIND_SPEED_MS = 8

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

// Open-Meteo WMO weather codes that specifically mean HEAVY rain (65, 82) or
// a thunderstorm (95/96/99) -- as opposed to the broader 'rainy' bucket
// (which also includes light drizzle, 51/53/55) that isn't worth pinging a
// friend's friends over.
const HEAVY_RAIN_CODES = new Set([65, 82])
const STORM_CODES = new Set([95, 96, 99])

function mapOpenMeteoCode(weatherCode: number, windSpeedKmh?: number): { condition: WeatherCondition; isSevere: boolean } | null {
  let base: WeatherCondition | null = null
  let isSevere = false

  if (weatherCode === 0 || weatherCode === 1) base = 'sunny'
  else if (weatherCode === 2 || weatherCode === 3 || weatherCode === 45 || weatherCode === 48) base = 'cloudy'
  else if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(weatherCode)) {
    base = 'rainy'
    isSevere = HEAVY_RAIN_CODES.has(weatherCode)
  } else if ([71, 73, 75, 77, 85, 86].includes(weatherCode)) base = 'snow'
  else if (STORM_CODES.has(weatherCode)) {
    base = 'stormy'
    isSevere = true
  }

  if (base === null) return null
  if ((base === 'sunny' || base === 'cloudy') && typeof windSpeedKmh === 'number' && windSpeedKmh >= WINDY_WIND_SPEED_KMH) {
    return { condition: 'windy', isSevere: false }
  }
  return { condition: base, isSevere }
}

function mapMetNorwaySymbol(symbolCode: string, windSpeedMs?: number): { condition: WeatherCondition; isSevere: boolean } | null {
  if (!symbolCode) return null
  const code = symbolCode.toLowerCase()

  let base: WeatherCondition | null = null
  let isSevere = false
  if (code.includes('thunder')) { base = 'stormy'; isSevere = true }
  else if (code.includes('sleet') || code.includes('snow')) base = 'snow'
  else if (code.includes('rain')) {
    base = 'rainy'
    isSevere = code.includes('heavy')
  }
  else if (code.includes('fog') || code.includes('cloud')) base = 'cloudy'
  else if (code.includes('clearsky') || code.includes('fair')) base = 'sunny'

  if (base === null) return null
  if ((base === 'sunny' || base === 'cloudy') && typeof windSpeedMs === 'number' && windSpeedMs >= WINDY_WIND_SPEED_MS) {
    return { condition: 'windy', isSevere: false }
  }
  return { condition: base, isSevere }
}

function mapWttrDescription(description: string, windSpeedKmh?: number): { condition: WeatherCondition; isSevere: boolean } | null {
  if (!description) return null
  const text = description.toLowerCase()

  let base: WeatherCondition | null = null
  let isSevere = false
  if (text.includes('thunder')) { base = 'stormy'; isSevere = true }
  else if (text.includes('snow') || text.includes('blizzard') || text.includes('ice') || text.includes('sleet')) base = 'snow'
  else if (text.includes('rain') || text.includes('drizzle')) {
    base = 'rainy'
    isSevere = text.includes('heavy') || text.includes('torrential')
  }
  else if (text.includes('fog') || text.includes('mist') || text.includes('cloud') || text.includes('overcast')) base = 'cloudy'
  else if (text.includes('sunny') || text.includes('clear')) base = 'sunny'

  if (base === null) return null
  if ((base === 'sunny' || base === 'cloudy') && typeof windSpeedKmh === 'number' && windSpeedKmh >= WINDY_WIND_SPEED_KMH) {
    return { condition: 'windy', isSevere: false }
  }
  return { condition: base, isSevere }
}

async function fetchOpenMeteo(latitude: number, longitude: number): Promise<WeatherResult> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,is_day,wind_speed_10m&timezone=auto`
  const data = await fetchWithTimeout(url)
  const current = data?.current
  if (!current || typeof current.weather_code !== 'number') {
    throw new Error('Open-Meteo response missing current.weather_code')
  }
  const mapped = mapOpenMeteoCode(current.weather_code, current.wind_speed_10m)
  if (!mapped) throw new Error(`Open-Meteo returned unmapped weather_code ${current.weather_code}`)
  return {
    condition: mapped.condition,
    isSevere: mapped.isSevere,
    isDay: current.is_day === 1,
    tempC: current.temperature_2m,
  }
}

async function fetchMetNorway(latitude: number, longitude: number): Promise<WeatherResult> {
  const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${latitude}&lon=${longitude}`
  const data = await fetchWithTimeout(url, { headers: { 'User-Agent': 'Circle-App/1.0' } })
  const first = data?.properties?.timeseries?.[0]
  const details = first?.data?.instant?.details
  const summary = first?.data?.next_1_hours?.summary?.symbol_code || first?.data?.next_6_hours?.summary?.symbol_code
  if (!summary) throw new Error('MET Norway response missing symbol_code')
  const mapped = mapMetNorwaySymbol(summary, details?.wind_speed)
  if (!mapped) throw new Error(`MET Norway returned unmapped symbol_code ${summary}`)
  const hour = new Date().getHours()
  return { condition: mapped.condition, isSevere: mapped.isSevere, isDay: hour >= 6 && hour < 18, tempC: details?.air_temperature }
}

async function fetchWttr(latitude: number, longitude: number): Promise<WeatherResult> {
  const url = `https://wttr.in/${latitude},${longitude}?format=j1`
  const data = await fetchWithTimeout(url)
  const current = data?.current_condition?.[0]
  const description = current?.weatherDesc?.[0]?.value
  if (!description) throw new Error('wttr.in response missing weatherDesc')
  const windSpeedKmh = current.windspeedKmph ? Number(current.windspeedKmph) : undefined
  const mapped = mapWttrDescription(description, windSpeedKmh)
  if (!mapped) throw new Error(`wttr.in returned unmapped description "${description}"`)
  const hour = new Date().getHours()
  return { condition: mapped.condition, isSevere: mapped.isSevere, isDay: hour >= 6 && hour < 18, tempC: current.temp_C ? Number(current.temp_C) : undefined }
}

const PROVIDERS = [fetchOpenMeteo, fetchMetNorway, fetchWttr]

/**
 * Tries each free/keyless weather provider in order, returning the first
 * successful, mappable result. Never throws -- resolves to null if every
 * provider fails, so callers can just skip that user/city for this run
 * rather than crash the whole batch.
 */
export async function fetchWeather(latitude: number, longitude: number): Promise<WeatherResult | null> {
  for (const provider of PROVIDERS) {
    try {
      return await provider(latitude, longitude)
    } catch (error) {
      logger.debug({ error, provider: provider.name }, '[weather] provider failed, trying next')
    }
  }
  return null
}
