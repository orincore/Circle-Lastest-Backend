-- Add instagram_username column to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS instagram_username TEXT;

-- Add index for faster lookups
CREATE INDEX IF NOT EXISTS idx_profiles_instagram_username 
ON profiles(instagram_username) 
WHERE instagram_username IS NOT NULL;

-- Add comment
COMMENT ON COLUMN profiles.instagram_username IS 'User Instagram handle for profile display and verification';
