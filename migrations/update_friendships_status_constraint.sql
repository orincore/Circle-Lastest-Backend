-- Update friendships table to allow 'inactive' status
-- This allows friendships to be marked as inactive instead of deleted

-- Drop the existing check constraint
ALTER TABLE friendships DROP CONSTRAINT IF EXISTS check_friendships_status;

-- Add new check constraint that includes 'inactive' status
ALTER TABLE friendships ADD CONSTRAINT check_friendships_status 
CHECK (status IN ('active', 'blocked', 'inactive'));

-- Verify the constraint was updated
SELECT 
    conname as constraint_name,
    pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint 
WHERE conname = 'check_friendships_status';
