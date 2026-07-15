-- Scroll Together (watch parties): a host and N guests scroll the nudges
-- feed in sync. The host's client drives the position; guests follow. The
-- feed itself is snapshotted into meme_ids at start (extended as the host
-- paginates) so every participant sees the exact same ordered list -- feeds
-- are personalized per user, so "everyone fetches their own feed" would
-- desync immediately.
create type watch_party_status as enum ('active', 'ended');

create table if not exists watch_party_sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references profiles(id),
  status watch_party_status not null default 'active',
  meme_ids uuid[] not null default '{}',
  current_index integer not null default 0,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);

-- A user hosts at most one live party at a time
create unique index if not exists watch_party_one_active_per_host
  on watch_party_sessions (host_id) where status <> 'ended';

create table if not exists watch_party_participants (
  session_id uuid not null references watch_party_sessions(id) on delete cascade,
  user_id uuid not null references profiles(id),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  primary key (session_id, user_id)
);

create index if not exists idx_watch_party_participants_user
  on watch_party_participants (user_id);
