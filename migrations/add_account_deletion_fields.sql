-- Migration to add account deletion tracking fields to profiles table

-- Add is_deleted column to track deleted accounts
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN DEFAULT FALSE;

-- Add deleted_at column to track when account was deleted
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;

-- Create index for faster queries on deleted accounts
CREATE INDEX IF NOT EXISTS idx_profiles_is_deleted ON profiles(is_deleted);
CREATE INDEX IF NOT EXISTS idx_profiles_deleted_at ON profiles(deleted_at);

-- Add comment for documentation
COMMENT ON COLUMN profiles.is_deleted IS 'Indicates if the account has been deleted by the user';
COMMENT ON COLUMN profiles.deleted_at IS 'Timestamp when the account was deleted';

-- Update existing deleted accounts (if any were manually marked)
-- This is safe to run even if no accounts exist
UPDATE profiles 
SET is_deleted = TRUE, deleted_at = NOW()
WHERE email LIKE 'deleted_%@deleted.com' 
AND is_deleted IS NULL;
