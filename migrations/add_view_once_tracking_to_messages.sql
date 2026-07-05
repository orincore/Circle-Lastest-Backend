-- Server-side enforcement for "view once" media messages.
-- Previously view-once was tracked only in client-side React state, which
-- reset on app restart or screen remount, and the message history endpoints
-- sent the real media_url unconditionally regardless of view state — so a
-- captured URL or a simple app restart made "view once" meaningless.

-- Whether this message's media should be viewable exactly one time.
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS is_view_once BOOLEAN NOT NULL DEFAULT FALSE;

-- Set the first (and only) time the view-once media was actually opened.
-- NULL = not yet viewed. Application code performs an atomic
-- "UPDATE ... WHERE view_once_viewed_at IS NULL" to consume it exactly once.
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS view_once_viewed_at TIMESTAMPTZ;

COMMENT ON COLUMN messages.is_view_once IS 'Media should only be viewable once, then permanently inaccessible';
COMMENT ON COLUMN messages.view_once_viewed_at IS 'When the view-once media was consumed; NULL means still unviewed. Set via an atomic conditional UPDATE so only the first viewer wins.';
