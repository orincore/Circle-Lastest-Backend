-- ========================================
-- SIMPLIFIED FRIEND REQUEST SYSTEM
-- Single table approach using friendships table
-- ========================================

-- Step 1: Add new status values to friendships table if not exists
-- Status values: 'pending', 'accepted', 'blocked', 'inactive'
-- Note: 'active' will be renamed to 'accepted' for clarity

-- Step 2: Migrate existing friend_requests to friendships table
-- This preserves all pending requests
INSERT INTO friendships (user1_id, user2_id, status, created_at, updated_at)
SELECT 
  LEAST(sender_id, receiver_id) as user1_id,
  GREATEST(sender_id, receiver_id) as user2_id,
  CASE 
    WHEN status = 'pending' THEN 'pending'
    WHEN status = 'accepted' THEN 'accepted'
    ELSE 'inactive'
  END as status,
  created_at,
  updated_at
FROM friend_requests
WHERE NOT EXISTS (
  SELECT 1 FROM friendships f
  WHERE (f.user1_id = LEAST(friend_requests.sender_id, friend_requests.receiver_id)
    AND f.user2_id = GREATEST(friend_requests.sender_id, friend_requests.receiver_id))
)
ON CONFLICT DO NOTHING;

-- Step 3: Add sender_id column to friendships to track who initiated the request
-- This is important for knowing who sent the friend request
ALTER TABLE friendships 
ADD COLUMN IF NOT EXISTS sender_id UUID REFERENCES profiles(id);

-- Step 4: Update sender_id for migrated requests
UPDATE friendships f
SET sender_id = fr.sender_id
FROM friend_requests fr
WHERE f.user1_id = LEAST(fr.sender_id, fr.receiver_id)
  AND f.user2_id = GREATEST(fr.sender_id, fr.receiver_id)
  AND f.sender_id IS NULL;

-- Step 5: For existing 'active' friendships, set sender_id to user1_id (arbitrary choice)
UPDATE friendships
SET sender_id = user1_id
WHERE status = 'active' AND sender_id IS NULL;

-- Step 6: Rename 'active' status to 'accepted' for consistency
UPDATE friendships
SET status = 'accepted'
WHERE status = 'active';

-- Step 7: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_friendships_user1_status ON friendships(user1_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_user2_status ON friendships(user2_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_sender ON friendships(sender_id);
CREATE INDEX IF NOT EXISTS idx_friendships_status ON friendships(status);
CREATE INDEX IF NOT EXISTS idx_friendships_created_at ON friendships(created_at DESC);

-- Step 8: Create a view for easier querying (optional)
CREATE OR REPLACE VIEW friend_requests_view AS
SELECT 
  id,
  sender_id,
  CASE 
    WHEN sender_id = user1_id THEN user2_id
    ELSE user1_id
  END as receiver_id,
  status,
  created_at,
  updated_at
FROM friendships
WHERE status = 'pending';

-- Step 9: Create a view for accepted friendships
CREATE OR REPLACE VIEW accepted_friendships_view AS
SELECT 
  id,
  user1_id,
  user2_id,
  sender_id,
  created_at,
  updated_at
FROM friendships
WHERE status = 'accepted';

-- Step 10: Add helpful comments
COMMENT ON COLUMN friendships.sender_id IS 'User who initiated the friend request';
COMMENT ON COLUMN friendships.status IS 'Status: pending (request sent), accepted (friends), blocked (blocked user), inactive (unfriended)';

-- Step 11: Backup old friend_requests table (don't drop yet, keep for safety)
-- ALTER TABLE friend_requests RENAME TO friend_requests_backup;

-- Note: After verifying everything works, you can drop the old table:
-- DROP TABLE IF EXISTS friend_requests_backup;

-- ========================================
-- HELPER FUNCTIONS
-- ========================================

-- Function to get friend request status between two users
CREATE OR REPLACE FUNCTION get_friendship_status(user_a UUID, user_b UUID)
RETURNS TEXT AS $$
DECLARE
  friendship_status TEXT;
BEGIN
  SELECT status INTO friendship_status
  FROM friendships
  WHERE (user1_id = LEAST(user_a, user_b) AND user2_id = GREATEST(user_a, user_b))
  LIMIT 1;
  
  RETURN COALESCE(friendship_status, 'none');
END;
$$ LANGUAGE plpgsql;

-- Function to check if user A sent request to user B
CREATE OR REPLACE FUNCTION is_request_sender(user_a UUID, user_b UUID)
RETURNS BOOLEAN AS $$
DECLARE
  request_sender UUID;
BEGIN
  SELECT sender_id INTO request_sender
  FROM friendships
  WHERE (user1_id = LEAST(user_a, user_b) AND user2_id = GREATEST(user_a, user_b))
    AND status = 'pending'
  LIMIT 1;
  
  RETURN request_sender = user_a;
END;
$$ LANGUAGE plpgsql;

-- ========================================
-- VERIFICATION QUERIES
-- ========================================

-- Check migrated data
-- SELECT COUNT(*) as total_friendships FROM friendships;
-- SELECT status, COUNT(*) FROM friendships GROUP BY status;
-- SELECT COUNT(*) as pending_requests FROM friendships WHERE status = 'pending';
-- SELECT COUNT(*) as accepted_friends FROM friendships WHERE status = 'accepted';

-- Verify sender_id is set for all records
-- SELECT COUNT(*) FROM friendships WHERE sender_id IS NULL;
