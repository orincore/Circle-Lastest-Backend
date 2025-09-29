-- Migration to add user statistics and Circle points system (Safe version)
-- This will track user engagement and calculate dynamic Circle scores

-- Add Circle points and statistics columns to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS circle_points INTEGER DEFAULT 100,
ADD COLUMN IF NOT EXISTS total_matches INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS messages_sent INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS messages_received INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS profile_visits_received INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS total_friends INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS stats_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Create user_activities table to track detailed user actions for points calculation
CREATE TABLE IF NOT EXISTS user_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  activity_type VARCHAR(50) NOT NULL, -- 'match_accepted', 'match_rejected', 'friend_added', 'friend_removed', 'message_sent', 'message_received', 'profile_visited', 'got_blocked', 'blocked_someone'
  points_change INTEGER NOT NULL, -- positive or negative points
  related_user_id UUID REFERENCES profiles(id), -- the other user involved in the activity
  metadata JSONB, -- additional data about the activity
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_activities_user_id ON user_activities(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activities_type ON user_activities(activity_type);
CREATE INDEX IF NOT EXISTS idx_user_activities_created_at ON user_activities(created_at);
CREATE INDEX IF NOT EXISTS idx_profiles_circle_points ON profiles(circle_points);
CREATE INDEX IF NOT EXISTS idx_profiles_last_active ON profiles(last_active);

-- Create user_profile_visits table to track who visited whose profile
CREATE TABLE IF NOT EXISTS user_profile_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  visited_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  visit_count INTEGER DEFAULT 1,
  first_visit_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_visit_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(visitor_id, visited_user_id)
);

-- Create indexes for profile visits
CREATE INDEX IF NOT EXISTS idx_profile_visits_visitor ON user_profile_visits(visitor_id);
CREATE INDEX IF NOT EXISTS idx_profile_visits_visited ON user_profile_visits(visited_user_id);
CREATE INDEX IF NOT EXISTS idx_profile_visits_last_visit ON user_profile_visits(last_visit_at);

-- Initialize existing users with default Circle points
UPDATE profiles 
SET circle_points = 100, 
    stats_updated_at = CURRENT_TIMESTAMP
WHERE circle_points IS NULL;

-- Create function to calculate and update user statistics (safe version)
CREATE OR REPLACE FUNCTION update_user_stats(user_uuid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles 
  SET 
    total_matches = (
      SELECT COUNT(*) 
      FROM matchmaking_proposals 
      WHERE (a = user_uuid OR b = user_uuid) 
      AND status = 'matched'
    ),
    messages_sent = (
      SELECT COUNT(*) 
      FROM messages 
      WHERE sender_id = user_uuid
    ),
    messages_received = (
      SELECT COUNT(*) 
      FROM messages m
      JOIN chat_members cm ON m.chat_id = cm.chat_id
      WHERE cm.user_id = user_uuid
      AND m.sender_id != user_uuid
    ),
    profile_visits_received = (
      SELECT COALESCE(SUM(visit_count), 0)
      FROM user_profile_visits 
      WHERE visited_user_id = user_uuid
    ),
    total_friends = (
      SELECT COUNT(*) 
      FROM friendships 
      WHERE (user1_id = user_uuid OR user2_id = user_uuid) 
      AND status = 'active'
    ),
    stats_updated_at = CURRENT_TIMESTAMP
  WHERE id = user_uuid;
EXCEPTION
  WHEN undefined_table THEN
    -- If matchmaking_proposals table doesn't exist, update other stats
    UPDATE profiles 
    SET 
      total_matches = 0,
      messages_sent = (
        SELECT COUNT(*) 
        FROM messages 
        WHERE sender_id = user_uuid
      ),
      messages_received = (
        SELECT COUNT(*) 
        FROM messages m
        JOIN chat_members cm ON m.chat_id = cm.chat_id
        WHERE cm.user_id = user_uuid
        AND m.sender_id != user_uuid
      ),
      profile_visits_received = (
        SELECT COALESCE(SUM(visit_count), 0)
        FROM user_profile_visits 
        WHERE visited_user_id = user_uuid
      ),
      total_friends = (
        SELECT COUNT(*) 
        FROM friendships 
        WHERE (user1_id = user_uuid OR user2_id = user_uuid) 
        AND status = 'active'
      ),
      stats_updated_at = CURRENT_TIMESTAMP
    WHERE id = user_uuid;
END;
$$ LANGUAGE plpgsql;

-- Create function to calculate Circle points based on activities
CREATE OR REPLACE FUNCTION calculate_circle_points(user_uuid UUID)
RETURNS INTEGER AS $$
DECLARE
  base_points INTEGER := 100;
  activity_points INTEGER := 0;
  total_points INTEGER;
BEGIN
  -- Calculate points from user activities
  SELECT COALESCE(SUM(points_change), 0) INTO activity_points
  FROM user_activities 
  WHERE user_id = user_uuid;
  
  total_points := base_points + activity_points;
  
  -- Ensure minimum points is 0
  IF total_points < 0 THEN
    total_points := 0;
  END IF;
  
  -- Update the user's circle points
  UPDATE profiles 
  SET circle_points = total_points,
      stats_updated_at = CURRENT_TIMESTAMP
  WHERE id = user_uuid;
  
  RETURN total_points;
END;
$$ LANGUAGE plpgsql;

-- Add comments for documentation
COMMENT ON COLUMN profiles.circle_points IS 'Dynamic Circle score based on user engagement and behavior';
COMMENT ON COLUMN profiles.total_matches IS 'Total number of successful matches';
COMMENT ON COLUMN profiles.messages_sent IS 'Total messages sent by user';
COMMENT ON COLUMN profiles.messages_received IS 'Total messages received by user';
COMMENT ON COLUMN profiles.profile_visits_received IS 'Total profile visits from other users';
COMMENT ON COLUMN profiles.total_friends IS 'Current number of active friends';
COMMENT ON COLUMN profiles.last_active IS 'Last time user was active on the platform';

COMMENT ON TABLE user_activities IS 'Tracks all user activities that affect Circle points';
COMMENT ON TABLE user_profile_visits IS 'Tracks profile visits between users';
