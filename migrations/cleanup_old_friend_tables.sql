-- =====================================================
-- CLEANUP OLD FRIEND REQUEST TABLES
-- =====================================================
-- This script removes the deprecated friend_requests table
-- and any related indexes/constraints
-- 
-- The new simplified system uses only the friendships table
-- with a status field ('pending', 'accepted', 'blocked', 'inactive')
-- =====================================================

-- Drop the old friend_requests table
-- This table is no longer needed as we now use friendships.status='pending'
DROP TABLE IF EXISTS friend_requests CASCADE;

-- Note: The friendships table is kept and enhanced with the status field
-- No changes needed to the friendships table structure

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================
-- Run these queries after migration to verify cleanup:

-- 1. Verify friend_requests table is dropped
-- SELECT EXISTS (
--   SELECT FROM information_schema.tables 
--   WHERE table_schema = 'public' 
--   AND table_name = 'friend_requests'
-- );
-- Expected result: false

-- 2. Verify friendships table still exists with status field
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'friendships' 
-- AND column_name = 'status';
-- Expected result: status | text (or character varying)

-- 3. Check current friendships data
-- SELECT status, COUNT(*) as count 
-- FROM friendships 
-- GROUP BY status;
-- Expected statuses: 'pending', 'accepted', 'active', 'inactive', 'blocked'

-- =====================================================
-- ROLLBACK SCRIPT (if needed)
-- =====================================================
-- If you need to rollback this migration, run:
/*
CREATE TABLE IF NOT EXISTS friend_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  receiver_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(sender_id, receiver_id)
);

CREATE INDEX IF NOT EXISTS idx_friend_requests_sender ON friend_requests(sender_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_receiver ON friend_requests(receiver_id);
CREATE INDEX IF NOT EXISTS idx_friend_requests_status ON friend_requests(status);
*/

-- =====================================================
-- MIGRATION NOTES
-- =====================================================
-- 1. Backup your database before running this script
-- 2. This is a destructive operation - all data in friend_requests will be lost
-- 3. Ensure all friend requests have been migrated to friendships table first
-- 4. The new system uses friendships.status='pending' for friend requests
-- 5. Run verification queries after migration to ensure success
