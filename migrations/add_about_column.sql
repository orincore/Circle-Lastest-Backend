-- Migration to add 'about' column to profiles table
-- This column will store user's bio/about section from signup

-- Add the about column to profiles table (allow NULL initially)
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS about TEXT;

-- Update existing profiles to have a default about text
-- This is for any existing users who signed up before this field was required
UPDATE profiles 
SET about = 'Hello! I''m excited to connect with new people and make meaningful friendships.'
WHERE about IS NULL OR about = '';

-- Add constraint to ensure about is within length limits (but allow existing data)
-- Remove any existing constraint first
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS check_about_length;

-- Add new constraint that allows reasonable length
ALTER TABLE profiles 
ADD CONSTRAINT check_about_length 
CHECK (about IS NULL OR LENGTH(about) <= 500);

-- Add comment to document the column
COMMENT ON COLUMN profiles.about IS 'User bio/about section - up to 500 characters';

-- Create index for potential search functionality on about text
DROP INDEX IF EXISTS idx_profiles_about_search;
CREATE INDEX idx_profiles_about_search ON profiles USING gin(to_tsvector('english', about)) 
WHERE about IS NOT NULL AND LENGTH(about) > 0;
