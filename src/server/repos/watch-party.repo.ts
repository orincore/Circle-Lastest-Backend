import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '../config/db.js'
import { watchPartySessions, watchPartyParticipants, profiles } from '../db/schema.js'

export interface WatchPartySession {
  id: string
  host_id: string
  status: 'active' | 'ended'
  meme_ids: string[]
  current_index: number
  created_at: string
  ended_at: string | null
}

export interface WatchPartyParticipant {
  session_id: string
  user_id: string
  joined_at: string
  left_at: string | null
  first_name: string | null
  last_name: string | null
  profile_photo_url: string | null
}

type SessionRow = typeof watchPartySessions.$inferSelect

function rowToSession(row: SessionRow): WatchPartySession {
  return {
    id: row.id,
    host_id: row.hostId,
    status: row.status,
    meme_ids: row.memeIds,
    current_index: row.currentIndex,
    created_at: row.createdAt,
    ended_at: row.endedAt,
  }
}

export async function getActiveSessionForHost(hostId: string): Promise<WatchPartySession | null> {
  const rows = await db.select().from(watchPartySessions)
    .where(and(eq(watchPartySessions.hostId, hostId), ne(watchPartySessions.status, 'ended'))).limit(1)
  return rows[0] ? rowToSession(rows[0]) : null
}

export async function getSession(sessionId: string): Promise<WatchPartySession | null> {
  const rows = await db.select().from(watchPartySessions).where(eq(watchPartySessions.id, sessionId)).limit(1)
  return rows[0] ? rowToSession(rows[0]) : null
}

/** Starts a new watch party, or returns the host's existing active one (idempotent). */
export async function startOrGetSession(hostId: string, memeIds: string[]): Promise<{ session: WatchPartySession; created: boolean }> {
  const existing = await getActiveSessionForHost(hostId)
  if (existing) return { session: existing, created: false }

  const rows = await db.insert(watchPartySessions).values({ hostId, memeIds }).returning()
  const session = rowToSession(rows[0])
  await db.insert(watchPartyParticipants).values({ sessionId: session.id, userId: hostId })
  return { session, created: true }
}

/** Appends newly-loaded meme ids as the host paginates further, skipping ones already in the snapshot. */
export async function extendMemeIds(sessionId: string, newMemeIds: string[]): Promise<WatchPartySession | null> {
  const session = await getSession(sessionId)
  if (!session) return null
  const existing = new Set(session.meme_ids)
  const toAppend = newMemeIds.filter((id) => !existing.has(id))
  if (!toAppend.length) return session
  const memeIds = [...session.meme_ids, ...toAppend]
  const rows = await db.update(watchPartySessions).set({ memeIds }).where(eq(watchPartySessions.id, sessionId)).returning()
  return rowToSession(rows[0])
}

export async function setCurrentIndex(sessionId: string, currentIndex: number): Promise<void> {
  await db.update(watchPartySessions).set({ currentIndex }).where(eq(watchPartySessions.id, sessionId))
}

export async function endSession(sessionId: string): Promise<void> {
  await db.update(watchPartySessions)
    .set({ status: 'ended', endedAt: new Date().toISOString() })
    .where(eq(watchPartySessions.id, sessionId))
  await db.update(watchPartyParticipants)
    .set({ leftAt: new Date().toISOString() })
    .where(and(eq(watchPartyParticipants.sessionId, sessionId), isNull(watchPartyParticipants.leftAt)))
}

export async function joinParty(sessionId: string, userId: string): Promise<void> {
  await db.insert(watchPartyParticipants).values({ sessionId, userId })
    .onConflictDoUpdate({
      target: [watchPartyParticipants.sessionId, watchPartyParticipants.userId],
      set: { leftAt: null },
    })
}

export async function leaveParty(sessionId: string, userId: string): Promise<void> {
  await db.update(watchPartyParticipants)
    .set({ leftAt: new Date().toISOString() })
    .where(and(eq(watchPartyParticipants.sessionId, sessionId), eq(watchPartyParticipants.userId, userId)))
}

export async function getActiveParticipants(sessionId: string): Promise<WatchPartyParticipant[]> {
  const rows = await db.select({
    sessionId: watchPartyParticipants.sessionId,
    userId: watchPartyParticipants.userId,
    joinedAt: watchPartyParticipants.joinedAt,
    leftAt: watchPartyParticipants.leftAt,
    firstName: profiles.firstName,
    lastName: profiles.lastName,
    profilePhotoUrl: profiles.profilePhotoUrl,
  })
    .from(watchPartyParticipants)
    .leftJoin(profiles, eq(profiles.id, watchPartyParticipants.userId))
    .where(and(eq(watchPartyParticipants.sessionId, sessionId), isNull(watchPartyParticipants.leftAt)))

  return rows.map((r) => ({
    session_id: r.sessionId,
    user_id: r.userId,
    joined_at: r.joinedAt,
    left_at: r.leftAt,
    first_name: r.firstName,
    last_name: r.lastName,
    profile_photo_url: r.profilePhotoUrl,
  }))
}

export async function isActiveParticipant(sessionId: string, userId: string): Promise<boolean> {
  const rows = await db.select({ userId: watchPartyParticipants.userId }).from(watchPartyParticipants)
    .where(and(
      eq(watchPartyParticipants.sessionId, sessionId),
      eq(watchPartyParticipants.userId, userId),
      isNull(watchPartyParticipants.leftAt),
    )).limit(1)
  return rows.length > 0
}
