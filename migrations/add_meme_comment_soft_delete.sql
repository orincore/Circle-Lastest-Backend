-- Lets a user delete their own comment (soft delete, matching the existing
-- active|hidden|flagged moderation pattern rather than a separate boolean
-- column) -- a deleted comment's replies stay visible but the deleted
-- comment itself renders as "[deleted]" in the UI rather than disappearing
-- outright, since Instagram-style flat replies would otherwise look orphaned.

BEGIN;

ALTER TABLE meme_comments DROP CONSTRAINT meme_comments_status_check;
ALTER TABLE meme_comments ADD CONSTRAINT meme_comments_status_check
	CHECK (status IN ('active', 'hidden', 'flagged', 'deleted'));

COMMIT;
