-- Threaded (one-level-deep, Instagram-style) replies for meme comments.
-- Replying to a reply still nests under its top-level ancestor rather than
-- creating deeper nesting -- enforced application-side (feed-memes.routes.ts
-- resolves the reply target to its top-level ancestor before inserting), not
-- by this schema (a self-referencing FK alone can't express "depth <= 1").

BEGIN;

ALTER TABLE meme_comments ADD COLUMN parent_comment_id uuid REFERENCES meme_comments(id) ON DELETE CASCADE;

-- Deleting a top-level comment cascades to delete its replies (ON DELETE
-- CASCADE above) -- this index makes "how many replies does this comment
-- have" / "give me this comment's replies" cheap.
CREATE INDEX idx_meme_comments_parent ON meme_comments(parent_comment_id, created_at);

COMMIT;
