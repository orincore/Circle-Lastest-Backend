-- Lets users upload their own memes (photo carousel or video) into the existing
-- memes/meme_assets pipeline, alongside Instagram-scraped content, so the feed,
-- ranking, likes/comments/share, and connect-requests all keep working unmodified
-- for user-generated posts too. Adds genre tagging (multi-select) and optional
-- trimmed YouTube background music (Reels-style).

-- memes.source_id was NOT NULL (every row came from meme_sources via scraping).
-- User uploads have no source; ownership instead lives in uploader_user_id.
alter table memes alter column source_id drop not null;

alter table memes add column if not exists uploader_user_id uuid references profiles(id) on delete cascade;
alter table memes add column if not exists origin varchar(20) not null default 'scraped'
  check (origin in ('scraped', 'user_upload'));

alter table memes add constraint memes_origin_owner_check check (
  (origin = 'scraped' and source_id is not null) or
  (origin = 'user_upload' and uploader_user_id is not null)
);

create index if not exists idx_memes_uploader on memes (uploader_user_id) where uploader_user_id is not null;

-- Optional attached YouTube track (Reels-style). music_start_seconds/music_trim_seconds
-- describe a trimmed clip (start offset + loop length in seconds) picked at upload time
-- via a hidden preview player; music_duration_seconds is the full track's length, kept
-- only for reference/validation (trim window must fit inside it).
alter table memes add column if not exists music_youtube_video_id text;
alter table memes add column if not exists music_title text;
alter table memes add column if not exists music_channel_title text;
alter table memes add column if not exists music_duration_seconds integer;
alter table memes add column if not exists music_start_seconds integer not null default 0;
alter table memes add column if not exists music_trim_seconds integer not null default 15;

-- Multi-select genre tagging (1-3 genres per meme) so the existing ranking pipeline
-- can learn per-user genre affinity the same way it already learns per-source affinity.
-- Fixed taxonomy enforced here; the canonical list is mirrored in
-- src/server/constants/memeGenres.ts and served to clients via GET /api/feed/genres --
-- that constant is the single source of truth clients read from, this CHECK just
-- guards the database directly and must be kept in sync with it.
create table if not exists meme_genres (
  meme_id uuid not null references memes(id) on delete cascade,
  genre varchar(30) not null check (genre in (
    'comedy', 'relatable', 'wholesome', 'dark_humor', 'animals', 'gaming',
    'anime', 'sports', 'desi', 'tech', 'politics', 'random'
  )),
  primary key (meme_id, genre)
);

create index if not exists idx_meme_genres_genre on meme_genres (genre);

-- Mirrors user_source_affinity exactly (see memeRanking.service.ts bumpAffinity),
-- same clamp range, just keyed on genre instead of meme_sources.id.
create table if not exists user_genre_affinity (
  user_id uuid not null references profiles(id) on delete cascade,
  genre varchar(30) not null,
  affinity_score double precision not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, genre)
);

create index if not exists idx_user_genre_affinity_user_id on user_genre_affinity (user_id);
