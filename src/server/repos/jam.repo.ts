import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { chatMembers, jamSessionParticipants, jamSessionQueue, jamSessions, profiles } from '../db/schema.js'

export interface JamQueueItem {
  id: string
  session_id: string
  youtube_video_id: string
  title: string
  channel_title: string | null
  thumbnail_url: string | null
  duration_seconds: number | null
  added_by: string
  status: 'queued' | 'playing' | 'played' | 'skipped'
  position: number
  is_auto_recommended: boolean
  created_at: string
}

export interface JamSession {
  id: string
  chat_id: string
  started_by: string
  status: 'active' | 'paused' | 'ended'
  current_queue_item_id: string | null
  playback_position_ms: number
  is_playing: boolean
  paused_for_presence: boolean
  last_position_synced_at: string
  created_at: string
  ended_at: string | null
}

/**
 * The server never runs its own playback clock — playback_position_ms is only ever written
 * at the moment of a play/pause/seek/track-change event, then frozen. While a session is
 * playing, the *true* current position is that frozen value plus whatever wall-clock time
 * has elapsed since it was written (last_position_synced_at). Callers that hand a position
 * to a client — sync replies, playback-state broadcasts, session hydration — must use this,
 * not the raw column, or "sync" ends up quietly rewinding playback instead of correcting it.
 */
export function computeLivePositionMs(session: JamSession): number {
  if (!session.is_playing) return session.playback_position_ms
  const elapsed = Date.now() - new Date(session.last_position_synced_at).getTime()
  return session.playback_position_ms + Math.max(0, elapsed)
}

type QueueRow = typeof jamSessionQueue.$inferSelect
type SessionRow = typeof jamSessions.$inferSelect

function rowToQueueItem(row: QueueRow): JamQueueItem {
  return {
    id: row.id,
    session_id: row.sessionId,
    youtube_video_id: row.youtubeVideoId,
    title: row.title,
    channel_title: row.channelTitle,
    thumbnail_url: row.thumbnailUrl,
    duration_seconds: row.durationSeconds,
    added_by: row.addedBy,
    status: row.status,
    position: row.position,
    is_auto_recommended: row.isAutoRecommended,
    created_at: row.createdAt,
  }
}

function rowToSession(row: SessionRow): JamSession {
  return {
    id: row.id,
    chat_id: row.chatId,
    started_by: row.startedBy,
    status: row.status,
    current_queue_item_id: row.currentQueueItemId,
    playback_position_ms: row.playbackPositionMs,
    is_playing: row.isPlaying,
    paused_for_presence: row.pausedForPresence,
    last_position_synced_at: row.lastPositionSyncedAt,
    created_at: row.createdAt,
    ended_at: row.endedAt,
  }
}

export async function getChatMemberIds(chatId: string): Promise<string[]> {
  const rows = await db.select({ userId: chatMembers.userId }).from(chatMembers).where(eq(chatMembers.chatId, chatId))
  return rows.map((r) => r.userId)
}

export async function isChatMember(chatId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ userId: chatMembers.userId }).from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId))).limit(1)
  return rows.length > 0
}

export async function getOtherChatMemberId(chatId: string, userId: string): Promise<string | null> {
  const rows = await db.select({ userId: chatMembers.userId }).from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), ne(chatMembers.userId, userId))).limit(1)
  return rows[0]?.userId ?? null
}

export async function getUserDisplayName(userId: string): Promise<string> {
  const rows = await db.select({ firstName: profiles.firstName, lastName: profiles.lastName, username: profiles.username })
    .from(profiles).where(eq(profiles.id, userId)).limit(1)
  const p = rows[0]
  if (!p) return 'Someone'
  const full = `${p.firstName || ''} ${p.lastName || ''}`.trim()
  return full || p.username || 'Someone'
}

export async function getActiveSessionForChat(chatId: string): Promise<JamSession | null> {
  const rows = await db.select().from(jamSessions)
    .where(and(eq(jamSessions.chatId, chatId), ne(jamSessions.status, 'ended'))).limit(1)
  return rows[0] ? rowToSession(rows[0]) : null
}

export async function getSession(sessionId: string): Promise<JamSession | null> {
  const rows = await db.select().from(jamSessions).where(eq(jamSessions.id, sessionId)).limit(1)
  return rows[0] ? rowToSession(rows[0]) : null
}

export async function getQueueForSession(sessionId: string): Promise<JamQueueItem[]> {
  const rows = await db.select().from(jamSessionQueue)
    .where(and(eq(jamSessionQueue.sessionId, sessionId), ne(jamSessionQueue.status, 'skipped')))
    .orderBy(asc(jamSessionQueue.position))
  return rows.map(rowToQueueItem)
}

/** Starts a new session, or reactivates+returns the existing active one for this chat (idempotent). */
export async function startOrGetSession(chatId: string, startedBy: string): Promise<{ session: JamSession; created: boolean }> {
  const existing = await getActiveSessionForChat(chatId)
  if (existing) return { session: existing, created: false }

  const rows = await db.insert(jamSessions).values({ chatId, startedBy }).returning()
  const session = rowToSession(rows[0])
  await db.insert(jamSessionParticipants).values({ sessionId: session.id, userId: startedBy })
  return { session, created: true }
}

export async function joinSession(sessionId: string, userId: string): Promise<void> {
  await db.insert(jamSessionParticipants).values({ sessionId, userId })
    .onConflictDoUpdate({
      target: [jamSessionParticipants.sessionId, jamSessionParticipants.userId],
      set: { leftAt: null },
    })
}

export async function leaveSession(sessionId: string, userId: string): Promise<void> {
  await db.update(jamSessionParticipants)
    .set({ leftAt: new Date().toISOString(), isPresent: false })
    .where(and(eq(jamSessionParticipants.sessionId, sessionId), eq(jamSessionParticipants.userId, userId)))
}

export async function endSession(sessionId: string): Promise<void> {
  await db.update(jamSessions)
    .set({ status: 'ended', isPlaying: false, endedAt: new Date().toISOString() })
    .where(eq(jamSessions.id, sessionId))
}

export async function setParticipantPresence(sessionId: string, userId: string, isPresent: boolean): Promise<void> {
  await db.insert(jamSessionParticipants).values({ sessionId, userId, isPresent })
    .onConflictDoUpdate({
      target: [jamSessionParticipants.sessionId, jamSessionParticipants.userId],
      set: { isPresent },
    })
}

export async function getParticipantPresence(sessionId: string): Promise<Record<string, boolean>> {
  const rows = await db.select({ userId: jamSessionParticipants.userId, isPresent: jamSessionParticipants.isPresent })
    .from(jamSessionParticipants).where(eq(jamSessionParticipants.sessionId, sessionId))
  return Object.fromEntries(rows.map((r) => [r.userId, r.isPresent]))
}

/** Appends a track to the end of the queue using fractional ordering (max existing position + 1000). */
export async function addToQueue(params: {
  sessionId: string
  youtubeVideoId: string
  title: string
  channelTitle?: string | null
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  addedBy: string
  isAutoRecommended?: boolean
}): Promise<JamQueueItem> {
  const [maxRow] = await db.select({ max: sql<number | null>`max(${jamSessionQueue.position})` })
    .from(jamSessionQueue).where(eq(jamSessionQueue.sessionId, params.sessionId))
  const position = (maxRow?.max ?? 0) + 1000

  const rows = await db.insert(jamSessionQueue).values({
    sessionId: params.sessionId,
    youtubeVideoId: params.youtubeVideoId,
    title: params.title,
    channelTitle: params.channelTitle ?? null,
    thumbnailUrl: params.thumbnailUrl ?? null,
    durationSeconds: params.durationSeconds ?? null,
    addedBy: params.addedBy,
    position,
    isAutoRecommended: params.isAutoRecommended ?? false,
  }).returning()
  return rowToQueueItem(rows[0])
}

export async function removeFromQueue(sessionId: string, queueItemId: string): Promise<void> {
  await db.delete(jamSessionQueue).where(and(eq(jamSessionQueue.id, queueItemId), eq(jamSessionQueue.sessionId, sessionId)))
}

/** All video IDs already played or queued in this session, for recommendation-exclusion. */
export async function getExcludedVideoIds(sessionId: string): Promise<string[]> {
  const rows = await db.select({ youtubeVideoId: jamSessionQueue.youtubeVideoId }).from(jamSessionQueue)
    .where(eq(jamSessionQueue.sessionId, sessionId))
  return rows.map((r) => r.youtubeVideoId)
}

export async function markQueueItemStatus(queueItemId: string, status: 'queued' | 'playing' | 'played' | 'skipped'): Promise<void> {
  await db.update(jamSessionQueue).set({ status }).where(eq(jamSessionQueue.id, queueItemId))
}

/** Advances the session to the given queue item (or clears it if null), resetting playback position. */
export async function setCurrentTrack(sessionId: string, queueItemId: string | null): Promise<void> {
  await db.update(jamSessions).set({
    currentQueueItemId: queueItemId,
    playbackPositionMs: 0,
    lastPositionSyncedAt: new Date().toISOString(),
  }).where(eq(jamSessions.id, sessionId))
}

export async function setPlaybackState(sessionId: string, updates: {
  isPlaying?: boolean
  positionMs?: number
  pausedForPresence?: boolean
}): Promise<void> {
  const set: Partial<typeof jamSessions.$inferInsert> = { lastPositionSyncedAt: new Date().toISOString() }
  if (updates.isPlaying !== undefined) set.isPlaying = updates.isPlaying
  if (updates.positionMs !== undefined) set.playbackPositionMs = updates.positionMs
  if (updates.pausedForPresence !== undefined) set.pausedForPresence = updates.pausedForPresence
  await db.update(jamSessions).set(set).where(eq(jamSessions.id, sessionId))
}

/** The next queued item after the current one, ordered by position (i.e. what "skip next" should play). */
export async function getNextQueueItem(sessionId: string, afterPosition: number | null): Promise<JamQueueItem | null> {
  const conditions = [eq(jamSessionQueue.sessionId, sessionId), eq(jamSessionQueue.status, 'queued')]
  const rows = await db.select().from(jamSessionQueue).where(and(...conditions)).orderBy(asc(jamSessionQueue.position))
  const candidates = afterPosition === null ? rows : rows.filter((r) => r.position > afterPosition)
  return candidates[0] ? rowToQueueItem(candidates[0]) : null
}

/** The most recently played item before the current one (i.e. what "previous" should play). */
export async function getPreviousQueueItem(sessionId: string, beforePosition: number): Promise<JamQueueItem | null> {
  const rows = await db.select().from(jamSessionQueue)
    .where(and(eq(jamSessionQueue.sessionId, sessionId), eq(jamSessionQueue.status, 'played')))
    .orderBy(asc(jamSessionQueue.position))
  const priors = rows.filter((r) => r.position < beforePosition)
  return priors.length ? rowToQueueItem(priors[priors.length - 1]) : null
}

export async function getQueueItem(queueItemId: string): Promise<JamQueueItem | null> {
  const rows = await db.select().from(jamSessionQueue).where(eq(jamSessionQueue.id, queueItemId)).limit(1)
  return rows[0] ? rowToQueueItem(rows[0]) : null
}
