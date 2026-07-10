import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '../config/db.js'
import { jamPlaylists, jamPlaylistTracks } from '../db/schema.js'

export interface JamPlaylist {
  id: string
  chat_id: string
  created_by: string
  name: string
  created_at: string
  updated_at: string
}

export interface JamPlaylistTrack {
  id: string
  playlist_id: string
  youtube_video_id: string
  title: string
  channel_title: string | null
  thumbnail_url: string | null
  duration_seconds: number | null
  position: number
  added_by: string
  created_at: string
}

type PlaylistRow = typeof jamPlaylists.$inferSelect
type TrackRow = typeof jamPlaylistTracks.$inferSelect

function rowToPlaylist(row: PlaylistRow): JamPlaylist {
  return {
    id: row.id,
    chat_id: row.chatId,
    created_by: row.createdBy,
    name: row.name,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

function rowToTrack(row: TrackRow): JamPlaylistTrack {
  return {
    id: row.id,
    playlist_id: row.playlistId,
    youtube_video_id: row.youtubeVideoId,
    title: row.title,
    channel_title: row.channelTitle,
    thumbnail_url: row.thumbnailUrl,
    duration_seconds: row.durationSeconds,
    position: row.position,
    added_by: row.addedBy,
    created_at: row.createdAt,
  }
}

export async function createPlaylist(chatId: string, createdBy: string, name: string): Promise<JamPlaylist> {
  const rows = await db.insert(jamPlaylists).values({ chatId, createdBy, name }).returning()
  return rowToPlaylist(rows[0])
}

export async function getPlaylist(playlistId: string): Promise<JamPlaylist | null> {
  const rows = await db.select().from(jamPlaylists).where(eq(jamPlaylists.id, playlistId)).limit(1)
  return rows[0] ? rowToPlaylist(rows[0]) : null
}

/** Playlists for a chat (i.e. shared by its two members), with track counts, most recently updated first. */
export async function getPlaylistsForChat(chatId: string): Promise<Array<JamPlaylist & { track_count: number }>> {
  const rows = await db
    .select({
      id: jamPlaylists.id,
      chatId: jamPlaylists.chatId,
      createdBy: jamPlaylists.createdBy,
      name: jamPlaylists.name,
      createdAt: jamPlaylists.createdAt,
      updatedAt: jamPlaylists.updatedAt,
      trackCount: sql<number>`count(${jamPlaylistTracks.id})::int`,
    })
    .from(jamPlaylists)
    .leftJoin(jamPlaylistTracks, eq(jamPlaylistTracks.playlistId, jamPlaylists.id))
    .where(eq(jamPlaylists.chatId, chatId))
    .groupBy(jamPlaylists.id)
    .orderBy(sql`${jamPlaylists.updatedAt} desc`)

  return rows.map((r) => ({
    id: r.id,
    chat_id: r.chatId,
    created_by: r.createdBy,
    name: r.name,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
    track_count: r.trackCount,
  }))
}

export async function renamePlaylist(playlistId: string, name: string): Promise<void> {
  await db.update(jamPlaylists).set({ name, updatedAt: new Date().toISOString() }).where(eq(jamPlaylists.id, playlistId))
}

export async function deletePlaylist(playlistId: string): Promise<void> {
  await db.delete(jamPlaylists).where(eq(jamPlaylists.id, playlistId))
}

export async function getPlaylistTracks(playlistId: string): Promise<JamPlaylistTrack[]> {
  const rows = await db.select().from(jamPlaylistTracks)
    .where(eq(jamPlaylistTracks.playlistId, playlistId))
    .orderBy(asc(jamPlaylistTracks.position))
  return rows.map(rowToTrack)
}

export async function addPlaylistTrack(params: {
  playlistId: string
  youtubeVideoId: string
  title: string
  channelTitle?: string | null
  thumbnailUrl?: string | null
  durationSeconds?: number | null
  addedBy: string
}): Promise<JamPlaylistTrack> {
  const [maxRow] = await db.select({ max: sql<number | null>`max(${jamPlaylistTracks.position})` })
    .from(jamPlaylistTracks).where(eq(jamPlaylistTracks.playlistId, params.playlistId))
  const position = (maxRow?.max ?? 0) + 1000

  const rows = await db.insert(jamPlaylistTracks).values({
    playlistId: params.playlistId,
    youtubeVideoId: params.youtubeVideoId,
    title: params.title,
    channelTitle: params.channelTitle ?? null,
    thumbnailUrl: params.thumbnailUrl ?? null,
    durationSeconds: params.durationSeconds ?? null,
    position,
    addedBy: params.addedBy,
  }).returning()

  await db.update(jamPlaylists).set({ updatedAt: new Date().toISOString() }).where(eq(jamPlaylists.id, params.playlistId))
  return rowToTrack(rows[0])
}

export async function removePlaylistTrack(playlistId: string, trackId: string): Promise<void> {
  await db.delete(jamPlaylistTracks).where(and(eq(jamPlaylistTracks.id, trackId), eq(jamPlaylistTracks.playlistId, playlistId)))
  await db.update(jamPlaylists).set({ updatedAt: new Date().toISOString() }).where(eq(jamPlaylists.id, playlistId))
}

/** Rewrites the whole track order for a playlist -- either participant can reorder it, this
 * isn't gated by who added which track. `trackIds` must be the playlist's full, reordered
 * track id list; positions are assigned by array index. */
export async function reorderPlaylistTracks(playlistId: string, trackIds: string[]): Promise<void> {
  await Promise.all(
    trackIds.map((trackId, index) =>
      db.update(jamPlaylistTracks)
        .set({ position: (index + 1) * 1000 })
        .where(and(eq(jamPlaylistTracks.id, trackId), eq(jamPlaylistTracks.playlistId, playlistId)))
    )
  )
  await db.update(jamPlaylists).set({ updatedAt: new Date().toISOString() }).where(eq(jamPlaylists.id, playlistId))
}
