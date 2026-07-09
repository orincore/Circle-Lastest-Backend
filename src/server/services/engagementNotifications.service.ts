import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { authSessions, engagementNotifications, memeLikes, memes, memeStats, profiles, userMarketingPreferences } from '../db/schema.js'
import { logger } from '../config/logger.js'
import { buildFriendshipMap } from '../repos/friends.repo.js'
import { ensureChatForUsers } from '../repos/chat.repo.js'
import { PushNotificationService } from './pushNotificationService.js'
import { NotificationService, type NotificationType } from './notificationService.js'
import { fetchWeather, type WeatherCondition } from './weatherService.js'
import { generateWeatherNotificationCopy, type WeatherNotificationCopy } from './ai/weather-notification-ai.service.js'
import { getLocationFromIp } from './ipGeolocationService.js'

/**
 * "Smart" re-engagement push notifications: friend-liked-a-meme, random
 * meme discovery, birthdays, and weather check-ins. Every feature here
 * shares two rules:
 *
 *  1. Never send the same thing to the same person twice -- claimSlot()
 *     below is the only way any of these functions are allowed to send,
 *     and it's backed by engagement_notifications' UNIQUE(recipient_id,
 *     notification_type, dedupe_key) constraint, so double-sends are
 *     impossible even under concurrent/overlapping runs, not just
 *     "unlikely".
 *  2. Respect user_marketing_preferences.pushEnabled -- these are
 *     re-engagement nudges, not transactional messages (a new chat
 *     message, a friend request), so anyone who opted out of marketing
 *     push gets skipped entirely.
 */

type EngagementType = 'meme_liked_by_friend' | 'meme_discovery' | 'birthday_self' | 'friend_birthday' | 'weather_checkin'

/**
 * Atomically claims a (recipient, type, dedupeKey) slot. Returns true only
 * if THIS call is the one that gets to send -- false means either it was
 * already sent (a real conflict) or something went wrong (fail closed:
 * skip rather than risk a duplicate).
 */
async function claimSlot(
  recipientId: string,
  type: EngagementType,
  dedupeKey: string,
  relatedUserId?: string | null,
  relatedMemeId?: string | null,
): Promise<boolean> {
  try {
    const rows = await db.insert(engagementNotifications)
      .values({
        recipientId,
        notificationType: type,
        dedupeKey,
        relatedUserId: relatedUserId || null,
        relatedMemeId: relatedMemeId || null,
      })
      .onConflictDoNothing()
      .returning({ id: engagementNotifications.id })
    return rows.length > 0
  } catch (error) {
    logger.error({ error, recipientId, type, dedupeKey }, 'Failed to claim engagement notification slot')
    return false
  }
}

const pushPrefCache = new Map<string, boolean>()

/** pushEnabled defaults true when no preferences row exists (matches the column default). */
async function isPushEnabled(userId: string): Promise<boolean> {
  if (pushPrefCache.has(userId)) return pushPrefCache.get(userId)!
  const [row] = await db.select({ pushEnabled: userMarketingPreferences.pushEnabled })
    .from(userMarketingPreferences).where(eq(userMarketingPreferences.userId, userId)).limit(1)
  const enabled = row?.pushEnabled !== false
  pushPrefCache.set(userId, enabled)
  return enabled
}

/**
 * Sends both the push and a matching in-app notification (push:false on
 * the in-app call so it doesn't double-push), gated on the recipient's
 * marketing push preference. Returns whether the push was actually sent.
 */
async function sendEngagementNotification(
  recipientId: string,
  notificationType: EngagementType,
  title: string,
  body: string,
  data: Record<string, any>,
): Promise<boolean> {
  if (!(await isPushEnabled(recipientId))) return false

  const pushed = await PushNotificationService.sendPushNotification(recipientId, {
    title, body, data, sound: 'default', priority: 'default',
  })

  await NotificationService.createNotification({
    recipient_id: recipientId,
    type: notificationType as NotificationType,
    title,
    message: body,
    data,
    push: false,
  })

  return pushed
}

// ===========================================================================
// 1. Friend liked a meme
// ===========================================================================
//
// Not per-like (a friend who likes 20 memes a day would spam their whole
// friend list 20x) -- up to MAX_FRIEND_LIKE_NOTIFICATIONS_PER_DAY per
// recipient, each for a distinct meme, picked from their friends' recent
// likes they haven't already liked themselves. Batches the friendship graph
// and recent-likes query once for the whole run instead of once per user.
const MAX_FRIEND_LIKE_NOTIFICATIONS_PER_DAY = 3

export async function sendFriendLikedMemeNotifications(): Promise<{ processed: number; sent: number }> {
  const stats = { processed: 0, sent: 0 }
  const today = new Date().toISOString().split('T')[0]
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  try {
    const friendshipMap = await buildFriendshipMap()
    if (friendshipMap.size === 0) return stats

    const recentLikes = await db.select({ memeId: memeLikes.memeId, likedBy: memeLikes.userId, likedAt: memeLikes.createdAt })
      .from(memeLikes)
      .where(gte(memeLikes.createdAt, since))

    if (recentLikes.length === 0) return stats

    // likedBy -> [{memeId, likedAt}]
    const likesByUser = new Map<string, Array<{ memeId: string; likedAt: string | null }>>()
    for (const like of recentLikes) {
      if (!likesByUser.has(like.likedBy)) likesByUser.set(like.likedBy, [])
      likesByUser.get(like.likedBy)!.push({ memeId: like.memeId, likedAt: like.likedAt })
    }

    // Every user who liked something recently is a candidate "friend who
    // liked something" -- only their friends can ever receive a
    // notification, so only look at recipients reachable from this set.
    const recipientCandidates = new Set<string>()
    for (const likerId of likesByUser.keys()) {
      const friendsOfLiker = friendshipMap.get(likerId)
      if (!friendsOfLiker) continue
      for (const friendId of friendsOfLiker) recipientCandidates.add(friendId)
    }
    if (recipientCandidates.size === 0) return stats

    // This recipient's own recent likes, to avoid suggesting a meme they
    // already liked themselves.
    const ownLikes = await db.select({ userId: memeLikes.userId, memeId: memeLikes.memeId })
      .from(memeLikes)
      .where(inArray(memeLikes.userId, [...recipientCandidates]))
    const ownLikedByUser = new Map<string, Set<string>>()
    for (const row of ownLikes) {
      if (!ownLikedByUser.has(row.userId)) ownLikedByUser.set(row.userId, new Set())
      ownLikedByUser.get(row.userId)!.add(row.memeId)
    }

    for (const recipientId of recipientCandidates) {
      stats.processed++
      try {
        const friendIds = friendshipMap.get(recipientId) || new Set()
        const alreadyLiked = ownLikedByUser.get(recipientId) || new Set()

        // One entry per distinct meme (first friend found gets the credit)
        // so the same recipient never gets two pushes about the same meme
        // in one day even if several friends liked it.
        const eligibleByMeme = new Map<string, string>()
        for (const friendId of friendIds) {
          const friendLikes = likesByUser.get(friendId)
          if (!friendLikes) continue
          for (const like of friendLikes) {
            if (alreadyLiked.has(like.memeId)) continue
            if (!eligibleByMeme.has(like.memeId)) eligibleByMeme.set(like.memeId, friendId)
          }
        }
        if (eligibleByMeme.size === 0) continue

        // Shuffle so which memes get picked (when there are more eligible
        // than the daily cap) varies run to run instead of always favoring
        // the same friend/meme.
        const candidates = [...eligibleByMeme.entries()]
        for (let i = candidates.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
        }

        let attempts = 0
        for (const [memeId, likedBy] of candidates) {
          if (attempts >= MAX_FRIEND_LIKE_NOTIFICATIONS_PER_DAY) break
          attempts++

          const claimed = await claimSlot(recipientId, 'meme_liked_by_friend', `${today}:${attempts}`, likedBy, memeId)
          if (!claimed) continue

          const [friend, meme] = await Promise.all([
            db.select({ firstName: profiles.firstName }).from(profiles).where(eq(profiles.id, likedBy)).limit(1).then(r => r[0]),
            db.select({ id: memes.id, status: memes.status }).from(memes).where(eq(memes.id, memeId)).limit(1).then(r => r[0]),
          ])
          if (!meme || meme.status !== 'active') continue

          const friendName = friend?.firstName || 'A friend'
          const sent = await sendEngagementNotification(
            recipientId,
            'meme_liked_by_friend',
            `${friendName} liked this meme 😂`,
            `See if you'll like it too!`,
            { type: 'meme_liked_by_friend', memeId, friendName },
          )
          if (sent) stats.sent++
        }
      } catch (error) {
        logger.error({ error, recipientId }, 'Error in friend-liked-meme notification for user')
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in sendFriendLikedMemeNotifications')
  }

  logger.info(stats, '😂 Friend-liked-a-meme notifications completed')
  return stats
}

// ===========================================================================
// 2. Random meme discovery
// ===========================================================================
//
// Picks from currently-trending memes (meme_stats.trending_score), not
// pure randomness, so the suggestion is actually good. Target cadence is
// 4-8 nudges/day/recipient -- driven by a dedicated cron that calls this
// function every 3 hours (DISCOVERY_SLOTS_PER_DAY = 8 slots/day; see
// workers/meme-discovery-scheduler.ts), with each user deterministically
// assigned a random subset of those 8 slots to actually receive a nudge in.
//
// The subset is derived from a seeded PRNG keyed on (userId, date) rather
// than a per-run coin flip, so: (a) it's reproducible if a slot's run
// retries, (b) every user lands somewhere in [4,8]/day instead of the
// binomial spread a per-run probability would produce (some users getting
// 0, others 8), and (c) it needs no extra state -- recomputed fresh each
// call from the two inputs.
const DISCOVERY_SLOTS_PER_DAY = 8
const DISCOVERY_MIN_PER_DAY = 4
const DISCOVERY_MAX_PER_DAY = 8
const TRENDING_POOL_SIZE = 30

/** Deterministic 32-bit FNV-1a hash, used to seed the per-user daily slot PRNG. */
function hashSeed(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Mulberry32 seeded PRNG -- deterministic per seed, good enough for this (not cryptographic). */
function mulberry32(seed: number): () => number {
  let a = seed
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Which of today's DISCOVERY_SLOTS_PER_DAY three-hour slots this user gets a discovery nudge in. */
function activeDiscoverySlotsForUser(userId: string, dateStr: string): Set<number> {
  const rand = mulberry32(hashSeed(`${userId}:${dateStr}`))
  const target = DISCOVERY_MIN_PER_DAY + Math.floor(rand() * (DISCOVERY_MAX_PER_DAY - DISCOVERY_MIN_PER_DAY + 1))
  const slots = Array.from({ length: DISCOVERY_SLOTS_PER_DAY }, (_, i) => i)
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[slots[i], slots[j]] = [slots[j], slots[i]]
  }
  return new Set(slots.slice(0, target))
}

/** slotIndex: which of the day's DISCOVERY_SLOTS_PER_DAY three-hour buckets this run covers (0-7, i.e. Math.floor(utcHour / 3)). */
export async function sendMemeDiscoveryNotifications(slotIndex: number): Promise<{ processed: number; sent: number }> {
  const stats = { processed: 0, sent: 0 }
  const today = new Date().toISOString().split('T')[0]

  try {
    const trending = await db.select({ id: memes.id, caption: memes.caption })
      .from(memes)
      .innerJoin(memeStats, eq(memeStats.memeId, memes.id))
      .where(eq(memes.status, 'active'))
      .orderBy(desc(memeStats.trendingScore))
      .limit(TRENDING_POOL_SIZE)

    if (trending.length === 0) {
      logger.info('No trending memes available for discovery notifications')
      return stats
    }

    const users = await db.select({ id: profiles.id })
      .from(profiles)
      .where(and(isNull(profiles.deletedAt), eq(profiles.isSuspended, false)))

    for (const user of users) {
      if (!activeDiscoverySlotsForUser(user.id, today).has(slotIndex)) continue
      stats.processed++
      try {
        const meme = trending[Math.floor(Math.random() * trending.length)]
        const claimed = await claimSlot(user.id, 'meme_discovery', `${today}:slot${slotIndex}`, null, meme.id)
        if (!claimed) continue

        const caption = (meme.caption || '').trim()
        const body = caption.length > 0
          ? (caption.length > 100 ? `${caption.slice(0, 97)}...` : caption)
          : 'Check out this meme everyone is talking about!'

        const sent = await sendEngagementNotification(
          user.id,
          'meme_discovery',
          '😂 Meme of the moment',
          body,
          { type: 'meme_discovery', memeId: meme.id },
        )
        if (sent) stats.sent++
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error in meme discovery notification for user')
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in sendMemeDiscoveryNotifications')
  }

  logger.info({ ...stats, slotIndex }, '🔥 Meme discovery notifications completed')
  return stats
}

// ===========================================================================
// 3. Birthdays
// ===========================================================================
//
// profiles has no timezone field, so "today" is evaluated in UTC (same
// reference every other cron in this codebase uses) -- someone's birthday
// push may land a few hours off from their actual local midnight, which is
// an acceptable approximation for a "happy birthday" nudge.
export async function sendBirthdayNotifications(): Promise<{ selfSent: number; friendSent: number }> {
  const stats = { selfSent: 0, friendSent: 0 }
  const year = new Date().getUTCFullYear()

  try {
    const birthdayUsers = await db.select({ id: profiles.id, firstName: profiles.firstName })
      .from(profiles)
      .where(and(
        isNull(profiles.deletedAt),
        eq(profiles.isSuspended, false),
        sql`${profiles.dateOfBirth} IS NOT NULL`,
        sql`EXTRACT(MONTH FROM ${profiles.dateOfBirth}) = EXTRACT(MONTH FROM CURRENT_DATE)`,
        sql`EXTRACT(DAY FROM ${profiles.dateOfBirth}) = EXTRACT(DAY FROM CURRENT_DATE)`,
      ))

    if (birthdayUsers.length === 0) return stats

    const friendshipMap = await buildFriendshipMap()

    for (const user of birthdayUsers) {
      const name = user.firstName || 'there'

      try {
        const claimedSelf = await claimSlot(user.id, 'birthday_self', String(year))
        if (claimedSelf) {
          const sent = await sendEngagementNotification(
            user.id,
            'birthday_self',
            `🎉 Happy Birthday, ${name}!`,
            'Wishing you an amazing year ahead! 🎂',
            { type: 'birthday_self' },
          )
          if (sent) stats.selfSent++
        }
      } catch (error) {
        logger.error({ error, userId: user.id }, 'Error sending self birthday notification')
      }

      const friendIds = friendshipMap.get(user.id)
      if (!friendIds || friendIds.size === 0) continue

      for (const friendId of friendIds) {
        try {
          const claimed = await claimSlot(friendId, 'friend_birthday', `${user.id}:${year}`, user.id)
          if (!claimed) continue

          const chat = await ensureChatForUsers(friendId, user.id)
          const sent = await sendEngagementNotification(
            friendId,
            'friend_birthday',
            `🎂 It's ${name}'s Birthday!`,
            `Today is ${name}'s birthday — send them a wish!`,
            { type: 'friend_birthday', chatId: chat.id, birthdayUserId: user.id, birthdayUserName: name },
          )
          if (sent) stats.friendSent++
        } catch (error) {
          logger.error({ error, friendId, birthdayUserId: user.id }, 'Error sending friend birthday notification')
        }
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in sendBirthdayNotifications')
  }

  logger.info(stats, '🎂 Birthday notifications completed')
  return stats
}

// ===========================================================================
// 4. Weather check-in
// ===========================================================================
//
// Users are grouped by rounded lat/long (~11km buckets) so everyone in the
// same area shares ONE weather API call instead of one per user -- both
// providers are free/keyless but there's no reason to hammer them
// per-user when a whole city shares the same weather. Fires for every
// weather condition (not just severe storms/heavy rain) at most once a day
// per (recipient, affected-friend) pair.
//
// Users with no fresh GPS on file (never granted location permission, or
// it's gone stale) still get a location approximated from their most
// recently active login session's IP address (see ipGeolocationService.ts)
// -- merged into the same GPS users list before bucketing, so it's just as
// cheap. GPS always wins: a user who has both is only ever sourced via GPS,
// so nobody is ever double-counted/double-notified. IP-derived coordinates
// are used ephemerally here only -- never written back to
// profiles.latitude/longitude, which other features rely on being precise.
//
// Copy is generated fresh each run via OpenAI's gpt-5-nano (see
// ai/weather-notification-ai.service.ts) so the wording doesn't feel like
// the same canned sentence every day -- cached per CONDITION for the whole
// run (not per group/user), so a run touching e.g. 3 rainy-weather groups
// still makes exactly one AI call for "rainy", reused everywhere. Falls
// back to WEATHER_COPY_FALLBACK (static, tailored per condition) if the AI
// call fails or OPENAI_API_KEY isn't set, so the feature never blocks on it.
const LOCATION_FRESHNESS_DAYS = 14
const IP_FALLBACK_SESSION_FRESHNESS_DAYS = 30 // session must have been active this recently for its IP to be a reasonable "where are they now" signal
const COORD_BUCKET_PRECISION = 1 // decimal places -- ~11km at the equator

const WEATHER_COPY_FALLBACK: Record<WeatherCondition, WeatherNotificationCopy> = {
  sunny: { title: "☀️ It's sunny near {name}", body: "It's sunny near {name}'s area ({area}). Perfect weather to say hi!" },
  cloudy: { title: "☁️ It's cloudy near {name}", body: "It's cloudy near {name}'s area ({area}). Check in and see how they're doing!" },
  windy: { title: "💨 It's windy near {name}", body: "It's windy near {name}'s area ({area}). Check in and see how they're doing!" },
  rainy: { title: "🌧️ It's rainy near {name}", body: "It's rainy near {name}'s area ({area}). Hope they're staying dry -- check in on them!" },
  snow: { title: "❄️ It's snowy near {name}", body: "It's snowy near {name}'s area ({area}). Stay warm -- check in on them!" },
  stormy: { title: "⛈️ It's stormy near {name}", body: "It's stormy near {name}'s area ({area}). Check in and see if everything's good!" },
}

function fillWeatherTemplate(template: string, name: string, area: string): string {
  return template.replaceAll('{name}', name).replaceAll('{area}', area)
}

/** Per-run cache so each distinct weather condition costs at most one OpenAI call, however many groups/users share it. */
const weatherCopyCache = new Map<WeatherCondition, WeatherNotificationCopy>()

async function getWeatherCopy(condition: WeatherCondition): Promise<WeatherNotificationCopy> {
  const cached = weatherCopyCache.get(condition)
  if (cached) return cached

  const generated = await generateWeatherNotificationCopy(condition)
  const copy = generated || WEATHER_COPY_FALLBACK[condition]
  weatherCopyCache.set(condition, copy)
  return copy
}

export async function sendWeatherCheckinNotifications(): Promise<{ groupsChecked: number; usersAffected: number; sent: number }> {
  const stats = { groupsChecked: 0, usersAffected: 0, sent: 0 }
  const today = new Date().toISOString().split('T')[0]
  const freshSince = new Date(Date.now() - LOCATION_FRESHNESS_DAYS * 24 * 60 * 60 * 1000).toISOString()

  try {
    const gpsUsers = await db.select({
      id: profiles.id,
      firstName: profiles.firstName,
      latitude: profiles.latitude,
      longitude: profiles.longitude,
      locationCity: profiles.locationCity,
    })
      .from(profiles)
      .where(and(
        isNull(profiles.deletedAt),
        eq(profiles.isSuspended, false),
        eq(profiles.invisibleMode, false),
        sql`${profiles.latitude} IS NOT NULL AND ${profiles.longitude} IS NOT NULL`,
        gte(profiles.locationUpdatedAt, freshSince),
      ))

    // IP fallback: users with no fresh GPS but a recently-active login
    // session carrying an IP we can approximate a location from. GPS users
    // are excluded so nobody is ever sourced twice.
    const gpsUserIds = new Set(gpsUsers.map(u => u.id))
    const sessionFreshSince = new Date(Date.now() - IP_FALLBACK_SESSION_FRESHNESS_DAYS * 24 * 60 * 60 * 1000).toISOString()

    const candidateSessions = await db.select({
      userId: authSessions.userId,
      ipAddress: authSessions.ipAddress,
      firstName: profiles.firstName,
      locationCity: profiles.locationCity,
    })
      .from(authSessions)
      .innerJoin(profiles, eq(profiles.id, authSessions.userId))
      .where(and(
        isNull(authSessions.revokedAt),
        sql`${authSessions.ipAddress} IS NOT NULL`,
        gte(authSessions.lastActiveAt, sessionFreshSince),
        isNull(profiles.deletedAt),
        eq(profiles.isSuspended, false),
        eq(profiles.invisibleMode, false),
      ))
      .orderBy(desc(authSessions.lastActiveAt))

    const ipFallbackUsers: typeof gpsUsers = []
    const seenViaIp = new Set<string>()
    for (const row of candidateSessions) {
      // Already ordered most-recent-first, so the first row seen per user
      // is their most recently active session -- skip GPS users and any
      // older session row for a user we've already resolved this run.
      if (gpsUserIds.has(row.userId) || seenViaIp.has(row.userId)) continue
      seenViaIp.add(row.userId)
      if (!row.ipAddress) continue

      const geo = await getLocationFromIp(row.ipAddress)
      if (!geo) continue

      ipFallbackUsers.push({
        id: row.userId,
        firstName: row.firstName,
        latitude: String(geo.lat),
        longitude: String(geo.lon),
        locationCity: row.locationCity || geo.city || null,
      })
    }

    const usersWithLocation = [...gpsUsers, ...ipFallbackUsers]
    if (usersWithLocation.length === 0) return stats

    logger.info({ gpsUsers: gpsUsers.length, ipFallbackUsers: ipFallbackUsers.length }, '🌧️ Weather check-in location sources')

    const groups = new Map<string, typeof usersWithLocation>()
    for (const user of usersWithLocation) {
      const lat = Number(user.latitude)
      const lon = Number(user.longitude)
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue
      const key = `${lat.toFixed(COORD_BUCKET_PRECISION)},${lon.toFixed(COORD_BUCKET_PRECISION)}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(user)
    }

    const friendshipMap = await buildFriendshipMap()

    for (const [key, groupUsers] of groups) {
      stats.groupsChecked++
      try {
        const [lat, lon] = key.split(',').map(Number)
        const weather = await fetchWeather(lat, lon)
        if (!weather) continue

        const copy = await getWeatherCopy(weather.condition)

        for (const user of groupUsers) {
          stats.usersAffected++
          const friendIds = friendshipMap.get(user.id)
          if (!friendIds || friendIds.size === 0) continue

          const name = user.firstName || 'Your friend'
          const areaLabel = user.locationCity || 'their area'

          for (const friendId of friendIds) {
            try {
              const claimed = await claimSlot(friendId, 'weather_checkin', `${user.id}:${today}`, user.id)
              if (!claimed) continue

              const chat = await ensureChatForUsers(friendId, user.id)
              const sent = await sendEngagementNotification(
                friendId,
                'weather_checkin',
                fillWeatherTemplate(copy.title, name, areaLabel),
                fillWeatherTemplate(copy.body, name, areaLabel),
                { type: 'weather_checkin', chatId: chat.id, targetUserId: user.id, targetUserName: name, condition: weather.condition },
              )
              if (sent) stats.sent++
            } catch (error) {
              logger.error({ error, friendId, targetUserId: user.id }, 'Error sending weather check-in notification')
            }
          }
        }
      } catch (error) {
        logger.error({ error, group: key }, 'Error checking weather for location group')
      }
    }
  } catch (error) {
    logger.error({ error }, 'Error in sendWeatherCheckinNotifications')
  }

  logger.info(stats, '🌧️ Weather check-in notifications completed')
  return stats
}
