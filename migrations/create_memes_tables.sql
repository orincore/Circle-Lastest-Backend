-- Meme scraping pipeline: sources (Instagram profiles we poll), memes (one row per
-- Instagram post), meme_assets (one row per media file -- handles single images,
-- multi-image carousels, and videos + optional thumbnail uniformly).
-- Plain Postgres, no RLS (post Supabase->Postgres migration).

BEGIN;

CREATE TABLE meme_sources (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	instagram_username text NOT NULL UNIQUE,
	display_name text,
	is_active boolean NOT NULL DEFAULT true,
	scrape_interval_minutes integer NOT NULL DEFAULT 60,
	last_scraped_at timestamptz,
	last_success_at timestamptz,
	consecutive_failures integer NOT NULL DEFAULT 0,
	backoff_until timestamptz,
	status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'backoff', 'disabled')),
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memes (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	source_id uuid NOT NULL REFERENCES meme_sources(id) ON DELETE CASCADE,
	instagram_shortcode text NOT NULL UNIQUE,
	post_type varchar(20) NOT NULL CHECK (post_type IN ('image', 'carousel', 'video')),
	caption text,
	like_count integer,
	posted_at timestamptz,
	scraped_at timestamptz NOT NULL DEFAULT now(),
	status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hidden', 'flagged')),
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memes_status_created ON memes(status, created_at DESC);
CREATE INDEX idx_memes_source ON memes(source_id);

CREATE TABLE meme_assets (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	meme_id uuid NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
	asset_type varchar(20) NOT NULL CHECK (asset_type IN ('image', 'video', 'thumbnail')),
	position integer NOT NULL DEFAULT 0,
	s3_key text NOT NULL,
	s3_url text NOT NULL,
	width integer,
	height integer,
	duration_seconds numeric,
	file_size_bytes bigint,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_meme_assets_meme ON meme_assets(meme_id);

COMMIT;
