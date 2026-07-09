-- Jam Session: listen-together music playback synced between two chat members
create type jam_session_status as enum ('active', 'paused', 'ended');
create type jam_queue_item_status as enum ('queued', 'playing', 'played', 'skipped');

create table if not exists jam_sessions (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references chats(id) on delete cascade,
  started_by uuid not null references profiles(id),
  status jam_session_status not null default 'active',
  current_queue_item_id uuid,
  playback_position_ms integer not null default 0,
  is_playing boolean not null default false,
  paused_for_presence boolean not null default false,  -- true when auto-paused because a participant isn't present; blocks auto-resume
  last_position_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

-- Only one live (non-ended) session per chat at a time
create unique index if not exists jam_sessions_one_active_per_chat
  on jam_sessions (chat_id) where status <> 'ended';

create index if not exists idx_jam_sessions_chat_id on jam_sessions (chat_id);

create table if not exists jam_session_participants (
  session_id uuid not null references jam_sessions(id) on delete cascade,
  user_id uuid not null references profiles(id),
  is_present boolean not null default false,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (session_id, user_id)
);

create index if not exists idx_jam_participants_user on jam_session_participants (user_id);

create table if not exists jam_session_queue (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references jam_sessions(id) on delete cascade,
  youtube_video_id text not null,
  title text not null,
  channel_title text,
  thumbnail_url text,
  duration_seconds integer,
  added_by uuid not null references profiles(id),
  status jam_queue_item_status not null default 'queued',
  position double precision not null,
  is_auto_recommended boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists idx_jam_queue_session_position on jam_session_queue (session_id, position);

alter table jam_sessions
  add constraint fk_jam_sessions_current_queue_item
  foreign key (current_queue_item_id) references jam_session_queue(id) on delete set null;
