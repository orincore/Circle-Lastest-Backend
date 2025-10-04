-- Cleanup script for orphaned data
-- This script identifies and optionally removes data inconsistencies

-- 1. Find profiles with location but missing required fields
SELECT 
  id,
  email,
  first_name,
  last_name,
  latitude,
  longitude,
  created_at
FROM profiles
WHERE 
  (latitude IS NOT NULL OR longitude IS NOT NULL)
  AND (first_name IS NULL OR last_name IS NULL);

-- 2. Count orphaned profiles
SELECT COUNT(*) as orphaned_profiles_count
FROM profiles
WHERE 
  (latitude IS NOT NULL OR longitude IS NOT NULL)
  AND (first_name IS NULL OR last_name IS NULL);

-- 3. Find friendships referencing non-existent users
SELECT 
  f.id as friendship_id,
  f.user1_id,
  f.user2_id,
  f.sender_id,
  f.status,
  CASE 
    WHEN p1.id IS NULL THEN 'user1_missing'
    WHEN p2.id IS NULL THEN 'user2_missing'
    WHEN ps.id IS NULL THEN 'sender_missing'
    ELSE 'all_exist'
  END as issue
FROM friendships f
LEFT JOIN profiles p1 ON f.user1_id = p1.id
LEFT JOIN profiles p2 ON f.user2_id = p2.id
LEFT JOIN profiles ps ON f.sender_id = ps.id
WHERE p1.id IS NULL OR p2.id IS NULL OR ps.id IS NULL;

-- 4. Count orphaned friendships
SELECT COUNT(*) as orphaned_friendships_count
FROM friendships f
LEFT JOIN profiles p1 ON f.user1_id = p1.id
LEFT JOIN profiles p2 ON f.user2_id = p2.id
LEFT JOIN profiles ps ON f.sender_id = ps.id
WHERE p1.id IS NULL OR p2.id IS NULL OR ps.id IS NULL;

-- CLEANUP COMMANDS (Run these after reviewing the above queries)
-- Uncomment to execute:

-- Remove location data from incomplete profiles
-- UPDATE profiles
-- SET 
--   latitude = NULL,
--   longitude = NULL,
--   location_address = NULL,
--   location_city = NULL,
--   location_country = NULL,
--   location_updated_at = NULL
-- WHERE 
--   (latitude IS NOT NULL OR longitude IS NOT NULL)
--   AND (first_name IS NULL OR last_name IS NULL);

-- Delete orphaned friendships
-- DELETE FROM friendships f
-- WHERE NOT EXISTS (
--   SELECT 1 FROM profiles WHERE id = f.user1_id
-- ) OR NOT EXISTS (
--   SELECT 1 FROM profiles WHERE id = f.user2_id
-- ) OR NOT EXISTS (
--   SELECT 1 FROM profiles WHERE id = f.sender_id
-- );

-- Specific cleanup for the problematic user ID
-- Check if this user exists
SELECT 
  id,
  email,
  first_name,
  last_name,
  created_at
FROM profiles
WHERE id = '16cfe830-3471-4abe-8a93-f3a68e35f8e5';

-- If the user doesn't exist, this query will show where their data appears
-- Check in friendships
SELECT * FROM friendships 
WHERE user1_id = '16cfe830-3471-4abe-8a93-f3a68e35f8e5' 
   OR user2_id = '16cfe830-3471-4abe-8a93-f3a68e35f8e5'
   OR sender_id = '16cfe830-3471-4abe-8a93-f3a68e35f8e5';

-- Check in chat_members
SELECT * FROM chat_members 
WHERE user_id = '16cfe830-3471-4abe-8a93-f3a68e35f8e5';

-- Check in messages
SELECT * FROM messages 
WHERE sender_id = '16cfe830-3471-4abe-8a93-f3a68e35f8e5';
