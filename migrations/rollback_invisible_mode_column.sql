-- Rollback Migration: Remove invisible_mode column from profiles table
-- Description: Removes the invisible_mode column if needed
-- Date: 2025-01-04

-- Drop the index first
DROP INDEX IF EXISTS idx_profiles_invisible_mode;

-- Remove the invisible_mode column
ALTER TABLE profiles 
DROP COLUMN IF EXISTS invisible_mode;

-- Verify the rollback
SELECT 
    column_name, 
    data_type, 
    is_nullable, 
    column_default
FROM information_schema.columns 
WHERE table_name = 'profiles' 
AND column_name = 'invisible_mode';

-- Should return no rows if rollback was successful
