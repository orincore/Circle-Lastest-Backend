-- ========================================
-- UPDATE FRIENDSHIPS TABLE CONSTRAINT
-- Add 'pending' and 'blocked' to allowed status values
-- ========================================

-- Step 1: Drop the existing check constraint
ALTER TABLE friendships 
DROP CONSTRAINT IF EXISTS check_friendships_status;

-- Step 2: Add the new check constraint with all status values
ALTER TABLE friendships 
ADD CONSTRAINT check_friendships_status 
CHECK (status IN ('pending', 'accepted', 'active', 'inactive', 'blocked'));

-- Note: We keep 'active' for backward compatibility, but 'accepted' is the new standard
-- 'active' will be migrated to 'accepted' in the next migration

-- Step 3: Add sender_id column if it doesn't exist
ALTER TABLE friendships 
ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES profiles(id);

-- Step 4: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_friendships_user1_status ON friendships(user1_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_user2_status ON friendships(user2_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_sender ON friendships(sender_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);
CREATE INDEX IF NOT EXISTS idx_friendships_created_at ON friendships(created_at DESC);

-- Step 5: Add helpful comments
COMMENT ON COLUMN friendships.status IS 'Status: pending (request sent), accepted/active (friends), blocked (blocked user), inactive (unfriended)';
COMMENT ON COLUMN friendships.sender_id IS 'User who initiated the friend request (for pending status)';

-- Verification query
-- SELECT constraint_name, check_clause 
-- FROM information_schema.check_constraints 
-- WHERE constraint_name = 'check_friendships_status';
