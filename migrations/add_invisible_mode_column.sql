-- Migration: Add invisible_mode column to profiles table
-- Description: Adds invisible_mode boolean column to allow users to hide from discovery features
-- Date: 2025-01-04

-- Add invisible_mode column to profiles table
ALTER TABLE profiles 
ADD COLUMN invisible_mode BOOLEAN DEFAULT FALSE;

-- Add comment to document the column purpose
COMMENT ON COLUMN profiles.invisible_mode IS 'When true, user is hidden from maps, explore, suggestions, and matchmaking';

-- Create index for performance when filtering out invisible users
CREATE INDEX idx_profiles_invisible_mode ON profiles(invisible_mode) WHERE invisible_mode = FALSE;

-- Update existing users to have invisible_mode = FALSE (explicit default)
UPDATE profiles 
SET invisible_mode = FALSE 
WHERE invisible_mode IS NULL;

-- Add NOT NULL constraint after setting defaults
ALTER TABLE profiles 
ALTER COLUMN invisible_mode SET NOT NULL;

-- Verify the migration
SELECT 
    column_name, 
    data_type, 
    is_nullable, 
    column_default
FROM information_schema.columns 
WHERE table_name = 'profiles' 
AND column_name = 'invisible_mode';

-- Show sample of updated data
SELECT 
    id, 
    first_name, 
    invisible_mode,
    created_at
FROM profiles 
LIMIT 5;
