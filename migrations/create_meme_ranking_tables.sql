-- Lightweight meme-feed ranking: per-meme engagement stats + trending score
-- (kept up to date incrementally at write-time, not via a batch job), and a
-- small per-user/per-source affinity table for personalization. See
-- services/memeRanking.service.ts for how these are used.

BEGIN;

-- One row per meme, created lazily on its first engagement event. Denormalized
-- counts + a precomputed trending_score so the feed query can ORDER BY a
-- single indexed column instead of aggregating raw event tables per request.
CREATE TABLE meme_stats (
	meme_id uuid PRIMARY KEY REFERENCES memes(id) ON DELETE CASCADE,
	like_count integer NOT NULL DEFAULT 0,
	comment_count integer NOT NULL DEFAULT 0,
	share_count integer NOT NULL DEFAULT 0,
	view_count integer NOT NULL DEFAULT 0,
	total_dwell_ms bigint NOT NULL DEFAULT 0,
	trending_score double precision NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meme_stats_trending_score ON meme_stats(trending_score DESC);

-- Tracks that a meme was shared, and by whom, for the share_count stat above
-- and for potential future "shared with you" style features.
CREATE TABLE meme_shares (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	meme_id uuid NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meme_shares_meme_id ON meme_shares(meme_id);
CREATE INDEX idx_meme_shares_user_id ON meme_shares(user_id);

-- How long a user actually watched/looked at a meme card, accumulated across
-- however many times it comes back into view in a session. Additive to the
-- existing (user_id, meme_id) row rather than a new table.
ALTER TABLE meme_feed_views ADD COLUMN duration_ms integer NOT NULL DEFAULT 0;

-- Lightweight personalization signal: how much a given user tends to engage
-- with content from a given meme source (like/comment/share/dwell), so the
-- feed can nudge ranking toward sources this user responds to without a full
-- recommendation model. Bounded (see memeRanking.service.ts) so it can't grow
-- unboundedly for very active users.
CREATE TABLE user_source_affinity (
	user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	source_id uuid NOT NULL REFERENCES meme_sources(id) ON DELETE CASCADE,
	affinity_score double precision NOT NULL DEFAULT 0,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, source_id)
);
CREATE INDEX idx_user_source_affinity_user_id ON user_source_affinity(user_id);

COMMIT;
