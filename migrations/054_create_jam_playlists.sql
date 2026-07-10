-- Playlists for jam sessions, scoped to the CHAT (the pair of users), not to a single
-- owner -- both chat members can create, edit, reorder, and delete these mutually, same
-- as they mutually control the jam session's own queue. Deliberately independent of
-- jam_sessions/jam_session_queue (which are scoped to and cleared with a single session)
-- so a saved playlist survives ending the jam session it was built or played in.
create table if not exists jam_playlists (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  created_by uuid not null references profiles(id),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_jam_playlists_chat on jam_playlists (chat_id);

create table if not exists jam_playlist_tracks (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references jam_playlists(id) on delete cascade,
  youtube_video_id text not null,
  title text not null,
  channel_title text,
  thumbnail_url text,
  duration_seconds integer,
  position double precision not null,
  added_by uuid not null references profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists idx_jam_playlist_tracks_playlist_position on jam_playlist_tracks (playlist_id, position);
