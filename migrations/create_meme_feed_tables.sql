-- Anonymous meme feed social layer: aliases, likes, comments, seen-tracking, and a
-- new (separate from blind-dating) connect-request flow. See
-- docs/MEME_FEED_IMPLEMENTATION.md for the full design.

BEGIN;

-- One persistent anonymous alias per user, created lazily on first feed interaction.
CREATE TABLE user_meme_aliases (
	user_id uuid PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
	alias text NOT NULL UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE meme_likes (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	meme_id uuid NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (meme_id, user_id)
);
CREATE INDEX idx_meme_likes_meme ON meme_likes(meme_id);
CREATE INDEX idx_meme_likes_user ON meme_likes(user_id);

CREATE TABLE meme_comments (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	meme_id uuid NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
	user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	text text NOT NULL,
	status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'flagged')),
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_meme_comments_meme_created ON meme_comments(meme_id, created_at DESC);

-- Per-user "seen" tracking so the feed can exclude/deprioritize repeats.
CREATE TABLE meme_feed_views (
	user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	meme_id uuid NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
	viewed_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, meme_id)
);

-- New, separate connect-request flow (NOT the existing blind_date_matches auto-match system).
CREATE TABLE meme_connect_requests (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	requester_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	target_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	context_meme_id uuid REFERENCES memes(id) ON DELETE SET NULL,
	status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
	chat_id uuid REFERENCES chats(id) ON DELETE SET NULL,
	requester_revealed boolean NOT NULL DEFAULT false,
	target_revealed boolean NOT NULL DEFAULT false,
	revealed_at timestamptz,
	created_at timestamptz NOT NULL DEFAULT now(),
	responded_at timestamptz,
	CHECK (requester_id != target_id)
);
CREATE UNIQUE INDEX idx_meme_connect_pending_pair ON meme_connect_requests(requester_id, target_id) WHERE status = 'pending';
CREATE INDEX idx_meme_connect_target ON meme_connect_requests(target_id, status);
CREATE INDEX idx_meme_connect_requester ON meme_connect_requests(requester_id, status);

-- Minimal, additive: lets a chat message carry a shared meme without touching the
-- existing media_type check constraint (which only allows image|video).
ALTER TABLE messages ADD COLUMN shared_meme_id uuid REFERENCES memes(id) ON DELETE SET NULL;

COMMIT;
