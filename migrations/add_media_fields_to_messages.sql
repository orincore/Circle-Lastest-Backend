-- Add media fields to messages table for image/video support
-- This migration adds support for media messages (images, videos) in chat

-- Add media_url column (URL to the uploaded media file)
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS media_url TEXT;

-- Add media_type column (image or video)
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS media_type TEXT CHECK (media_type IN ('image', 'video') OR media_type IS NULL);

-- Add thumbnail column (for video thumbnails)
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS thumbnail TEXT;

-- Add index on media_url for faster queries
CREATE INDEX IF NOT EXISTS idx_messages_media_url ON messages(media_url) WHERE media_url IS NOT NULL;

-- Add comment
COMMENT ON COLUMN messages.media_url IS 'URL to uploaded media file (image or video)';
COMMENT ON COLUMN messages.media_type IS 'Type of media: image or video';
COMMENT ON COLUMN messages.thumbnail IS 'Thumbnail URL for video messages';
