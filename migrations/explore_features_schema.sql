-- SQL Schema for Explore Features
-- This file contains all the necessary tables and indexes for the explore functionality

-- ============================================================================
-- PROFILES TABLE ENHANCEMENTS
-- ============================================================================

-- Add indexes for explore queries (if not already exists)
CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_created_at ON profiles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiles_first_name ON profiles(first_name);
CREATE INDEX IF NOT EXISTS idx_profiles_last_name ON profiles(last_name);
CREATE INDEX IF NOT EXISTS idx_profiles_username ON profiles(username);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);

-- Add composite index for explore filtering
CREATE INDEX IF NOT EXISTS idx_profiles_explore_filter ON profiles(id, first_name, last_name, updated_at) 
WHERE first_name IS NOT NULL AND last_name IS NOT NULL;

-- Add index for new users query (last 7 days)
CREATE INDEX IF NOT EXISTS idx_profiles_recent_users ON profiles(created_at DESC, first_name, last_name) 
WHERE first_name IS NOT NULL AND last_name IS NOT NULL;

-- ============================================================================
-- FRIENDSHIPS TABLE INDEXES
-- ============================================================================

-- Ensure friendships table has proper indexes for explore filtering
CREATE INDEX IF NOT EXISTS idx_friendships_user1_status ON friendships(user1_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_user2_status ON friendships(user2_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_status_active ON friendships(status) WHERE status = 'active';

-- Composite index for efficient friendship lookups
CREATE INDEX IF NOT EXISTS idx_friendships_users_status ON friendships(user1_id, user2_id, status);

-- ============================================================================
-- BLOCKS TABLE INDEXES
-- ============================================================================

-- Ensure blocks table has proper indexes for explore filtering
CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id);
CREATE INDEX IF NOT EXISTS idx_blocks_both_users ON blocks(blocker_id, blocked_id);

-- ============================================================================
-- SEARCH OPTIMIZATION
-- ============================================================================

-- Add full-text search indexes for better search performance
-- Note: These are PostgreSQL specific. Adjust for other databases if needed.

-- Create a GIN index for full-text search on names and usernames
CREATE INDEX IF NOT EXISTS idx_profiles_fulltext_search ON profiles 
USING gin(to_tsvector('english', 
  COALESCE(first_name, '') || ' ' || 
  COALESCE(last_name, '') || ' ' || 
  COALESCE(username, '') || ' ' || 
  COALESCE(email, '')
));

-- Create individual indexes for ILIKE searches (case-insensitive)
CREATE INDEX IF NOT EXISTS idx_profiles_first_name_ilike ON profiles(first_name text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_last_name_ilike ON profiles(last_name text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_username_ilike ON profiles(username text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_email_ilike ON profiles(email text_pattern_ops);

-- ============================================================================
-- COMPATIBILITY SCORING INDEXES
-- ============================================================================

-- Add indexes for compatibility calculation fields
CREATE INDEX IF NOT EXISTS idx_profiles_age ON profiles(age) WHERE age IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_gender ON profiles(gender) WHERE gender IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_location ON profiles(latitude, longitude) 
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Add GIN indexes for array fields (interests and needs)
CREATE INDEX IF NOT EXISTS idx_profiles_interests_gin ON profiles USING gin(interests);
CREATE INDEX IF NOT EXISTS idx_profiles_needs_gin ON profiles USING gin(needs);

-- ============================================================================
-- PERFORMANCE OPTIMIZATION VIEWS
-- ============================================================================

-- Create a materialized view for top users (optional - for very high traffic)
-- This can be refreshed daily to improve performance
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_top_users AS
SELECT 
  id,
  first_name,
  last_name,
  username,
  email,
  profile_photo_url,
  age,
  gender,
  interests,
  needs,
  created_at,
  updated_at,
  -- Calculate a "completeness score" for ranking
  (
    CASE WHEN first_name IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN last_name IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN profile_photo_url IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN age IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN gender IS NOT NULL THEN 1 ELSE 0 END +
    CASE WHEN interests IS NOT NULL AND array_length(interests, 1) > 0 THEN 2 ELSE 0 END +
    CASE WHEN needs IS NOT NULL AND array_length(needs, 1) > 0 THEN 2 ELSE 0 END
  ) as completeness_score
FROM profiles
WHERE first_name IS NOT NULL 
  AND last_name IS NOT NULL
ORDER BY completeness_score DESC, updated_at DESC;

-- Create index on the materialized view
CREATE INDEX IF NOT EXISTS idx_mv_top_users_score ON mv_top_users(completeness_score DESC, updated_at DESC);

-- ============================================================================
-- CACHE MANAGEMENT TABLE (Optional)
-- ============================================================================

-- Create a table to track cache statistics and management
-- This is optional but useful for monitoring cache performance
CREATE TABLE IF NOT EXISTS explore_cache_stats (
  id SERIAL PRIMARY KEY,
  cache_key VARCHAR(255) NOT NULL,
  user_id UUID NOT NULL,
  endpoint VARCHAR(100) NOT NULL,
  hit_count INTEGER DEFAULT 0,
  last_hit TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

-- Add indexes for cache stats
CREATE INDEX IF NOT EXISTS idx_cache_stats_user_endpoint ON explore_cache_stats(user_id, endpoint);
CREATE INDEX IF NOT EXISTS idx_cache_stats_expires ON explore_cache_stats(expires_at);
CREATE INDEX IF NOT EXISTS idx_cache_stats_cache_key ON explore_cache_stats(cache_key);

-- ============================================================================
-- FUNCTIONS FOR EXPLORE FEATURES
-- ============================================================================

-- Function to calculate user compatibility score
CREATE OR REPLACE FUNCTION calculate_compatibility_score(
  user1_id UUID,
  user2_id UUID
) RETURNS INTEGER AS $$
DECLARE
  user1_record profiles%ROWTYPE;
  user2_record profiles%ROWTYPE;
  score INTEGER := 0;
  age_diff INTEGER;
  common_interests INTEGER;
  common_needs INTEGER;
  distance_km FLOAT;
BEGIN
  -- Get user records
  SELECT * INTO user1_record FROM profiles WHERE id = user1_id;
  SELECT * INTO user2_record FROM profiles WHERE id = user2_id;
  
  -- Age compatibility (max 20 points)
  IF user1_record.age IS NOT NULL AND user2_record.age IS NOT NULL THEN
    age_diff := ABS(user1_record.age - user2_record.age);
    IF age_diff <= 2 THEN score := score + 20;
    ELSIF age_diff <= 5 THEN score := score + 15;
    ELSIF age_diff <= 10 THEN score := score + 10;
    ELSIF age_diff <= 15 THEN score := score + 5;
    END IF;
  END IF;
  
  -- Interest overlap (max 30 points)
  IF user1_record.interests IS NOT NULL AND user2_record.interests IS NOT NULL THEN
    SELECT array_length(
      ARRAY(SELECT unnest(user1_record.interests) INTERSECT SELECT unnest(user2_record.interests)), 1
    ) INTO common_interests;
    score := score + LEAST(30, COALESCE(common_interests, 0) * 5);
  END IF;
  
  -- Needs compatibility (max 25 points)
  IF user1_record.needs IS NOT NULL AND user2_record.needs IS NOT NULL THEN
    SELECT array_length(
      ARRAY(SELECT unnest(user1_record.needs) INTERSECT SELECT unnest(user2_record.needs)), 1
    ) INTO common_needs;
    score := score + LEAST(25, COALESCE(common_needs, 0) * 8);
  END IF;
  
  -- Location proximity (max 25 points)
  IF user1_record.latitude IS NOT NULL AND user1_record.longitude IS NOT NULL 
     AND user2_record.latitude IS NOT NULL AND user2_record.longitude IS NOT NULL THEN
    
    -- Calculate distance using Haversine formula
    distance_km := (
      6371 * acos(
        cos(radians(user1_record.latitude)) * 
        cos(radians(user2_record.latitude)) * 
        cos(radians(user2_record.longitude) - radians(user1_record.longitude)) + 
        sin(radians(user1_record.latitude)) * 
        sin(radians(user2_record.latitude))
      )
    );
    
    IF distance_km <= 5 THEN score := score + 25;
    ELSIF distance_km <= 15 THEN score := score + 20;
    ELSIF distance_km <= 50 THEN score := score + 15;
    ELSIF distance_km <= 100 THEN score := score + 10;
    ELSIF distance_km <= 500 THEN score := score + 5;
    END IF;
  END IF;
  
  RETURN score;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- REFRESH FUNCTIONS
-- ============================================================================

-- Function to refresh materialized view (call this daily)
CREATE OR REPLACE FUNCTION refresh_explore_data() RETURNS VOID AS $$
BEGIN
  -- Refresh the materialized view
  REFRESH MATERIALIZED VIEW mv_top_users;
  
  -- Clean up old cache stats (older than 30 days)
  DELETE FROM explore_cache_stats 
  WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '30 days';
  
  -- Log the refresh
  RAISE NOTICE 'Explore data refreshed at %', CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- SCHEDULED REFRESH (Optional - requires pg_cron extension)
-- ============================================================================

-- Uncomment the following line if you have pg_cron extension installed
-- This will automatically refresh the explore data daily at 2 AM
-- SELECT cron.schedule('refresh-explore-data', '0 2 * * *', 'SELECT refresh_explore_data();');

-- ============================================================================
-- SAMPLE QUERIES FOR TESTING
-- ============================================================================

-- Test query for top users
/*
SELECT 
  id, 
  first_name, 
  last_name, 
  username,
  completeness_score
FROM mv_top_users 
WHERE id NOT IN (
  SELECT user2_id FROM friendships WHERE user1_id = 'your-user-id' AND status = 'active'
  UNION
  SELECT user1_id FROM friendships WHERE user2_id = 'your-user-id' AND status = 'active'
)
LIMIT 5;
*/

-- Test query for new users (last 7 days)
/*
SELECT 
  id, 
  first_name, 
  last_name, 
  username,
  created_at
FROM profiles 
WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days'
  AND first_name IS NOT NULL 
  AND last_name IS NOT NULL
  AND id != 'your-user-id'
ORDER BY created_at DESC
LIMIT 5;
*/

-- Test query for user search
/*
SELECT 
  id, 
  first_name, 
  last_name, 
  username,
  email
FROM profiles 
WHERE (
  first_name ILIKE '%search-term%' OR 
  last_name ILIKE '%search-term%' OR 
  username ILIKE '%search-term%' OR 
  email ILIKE '%search-term%'
)
AND id != 'your-user-id'
LIMIT 20;
*/

-- ============================================================================
-- PERFORMANCE MONITORING
-- ============================================================================

-- Query to check index usage
/*
SELECT 
  schemaname,
  tablename,
  indexname,
  idx_scan,
  idx_tup_read,
  idx_tup_fetch
FROM pg_stat_user_indexes 
WHERE tablename IN ('profiles', 'friendships', 'blocks')
ORDER BY idx_scan DESC;
*/

-- Query to check table sizes
/*
SELECT 
  tablename,
  pg_size_pretty(pg_total_relation_size(tablename::regclass)) as size
FROM pg_tables 
WHERE tablename IN ('profiles', 'friendships', 'blocks', 'mv_top_users')
ORDER BY pg_total_relation_size(tablename::regclass) DESC;
*/
