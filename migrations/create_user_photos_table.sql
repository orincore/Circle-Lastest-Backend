-- Migration: Create user_photos table for photo gallery feature
-- Description: Allows users to upload up to 5 photos to their profile gallery
-- Date: 2025-01-14

-- Create user_photos table
CREATE TABLE IF NOT EXISTS user_photos (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    photo_url TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Ensure user doesn't exceed 5 photos (enforced at application level too)
    CONSTRAINT valid_photo_url CHECK (photo_url ~ '^https?://.*')
);

-- Create index for faster queries
CREATE INDEX IF NOT EXISTS idx_user_photos_user_id ON user_photos(user_id);
CREATE INDEX IF NOT EXISTS idx_user_photos_created_at ON user_photos(created_at DESC);

-- Enable Row Level Security
ALTER TABLE user_photos ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own photos
CREATE POLICY "Users can view their own photos" ON user_photos
    FOR SELECT
    USING (user_id = auth.uid());

-- RLS Policy: Users can view other users' photos (public gallery)
CREATE POLICY "Users can view other users photos" ON user_photos
    FOR SELECT
    USING (true);

-- RLS Policy: Users can insert their own photos (max 5 enforced at app level)
CREATE POLICY "Users can insert their own photos" ON user_photos
    FOR INSERT
    WITH CHECK (user_id = auth.uid());

-- RLS Policy: Users can delete their own photos
CREATE POLICY "Users can delete their own photos" ON user_photos
    FOR DELETE
    USING (user_id = auth.uid());

-- RLS Policy: Users can update their own photos
CREATE POLICY "Users can update their own photos" ON user_photos
    FOR UPDATE
    USING (user_id = auth.uid())
    WITH CHECK (user_id = auth.uid());

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_user_photos_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
DROP TRIGGER IF EXISTS update_user_photos_updated_at_trigger ON user_photos;
CREATE TRIGGER update_user_photos_updated_at_trigger
    BEFORE UPDATE ON user_photos
    FOR EACH ROW
    EXECUTE FUNCTION update_user_photos_updated_at();

-- Create function to count user photos (helper for max limit check)
CREATE OR REPLACE FUNCTION get_user_photo_count(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    photo_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO photo_count
    FROM user_photos
    WHERE user_id = p_user_id;
    
    RETURN photo_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission on the function
GRANT EXECUTE ON FUNCTION get_user_photo_count(UUID) TO authenticated;

-- Add comment to table
COMMENT ON TABLE user_photos IS 'Stores user photo gallery images (max 5 per user)';
COMMENT ON COLUMN user_photos.id IS 'Unique identifier for the photo';
COMMENT ON COLUMN user_photos.user_id IS 'Reference to the user who owns this photo';
COMMENT ON COLUMN user_photos.photo_url IS 'S3 URL of the photo';
COMMENT ON COLUMN user_photos.created_at IS 'Timestamp when photo was uploaded';
COMMENT ON COLUMN user_photos.updated_at IS 'Timestamp when photo was last updated';

-- Verification query (run after migration)
-- SELECT 
--     u.id as user_id,
--     u.email,
--     COUNT(up.id) as photo_count,
--     ARRAY_AGG(up.photo_url ORDER BY up.created_at DESC) as photos
-- FROM auth.users u
-- LEFT JOIN user_photos up ON u.id = up.user_id
-- GROUP BY u.id, u.email
-- ORDER BY photo_count DESC;
