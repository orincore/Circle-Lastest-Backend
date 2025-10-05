-- Add deletion_feedback column to profiles table
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS deletion_feedback TEXT;

-- Add comment
COMMENT ON COLUMN profiles.deletion_feedback IS 'Additional feedback provided by user during account deletion';
