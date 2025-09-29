-- Migration to create matchmaking_proposals table and fix match counting
-- This ensures the Circle stats system can accurately count matches

-- Create matchmaking_proposals table for tracking matches
CREATE TABLE IF NOT EXISTS matchmaking_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    a UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    b UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status VARCHAR(20) DEFAULT 'pending',
    type VARCHAR(50) DEFAULT 'regular',
    matched_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance when counting matches
CREATE INDEX IF NOT EXISTS idx_matchmaking_proposals_status ON matchmaking_proposals(status);
CREATE INDEX IF NOT EXISTS idx_matchmaking_proposals_user_a ON matchmaking_proposals(a);
CREATE INDEX IF NOT EXISTS idx_matchmaking_proposals_user_b ON matchmaking_proposals(b);
CREATE INDEX IF NOT EXISTS idx_matchmaking_proposals_matched_at ON matchmaking_proposals(matched_at);

-- Add comments for documentation
COMMENT ON TABLE matchmaking_proposals IS 'Tracks matchmaking proposals and successful matches for statistics';
COMMENT ON COLUMN matchmaking_proposals.a IS 'First user in the match';
COMMENT ON COLUMN matchmaking_proposals.b IS 'Second user in the match';
COMMENT ON COLUMN matchmaking_proposals.status IS 'Status of the proposal: pending, matched, cancelled, expired';
COMMENT ON COLUMN matchmaking_proposals.type IS 'Type of match: regular, message_request';
COMMENT ON COLUMN matchmaking_proposals.matched_at IS 'Timestamp when both users accepted and became matched';

-- Alternative: Create a dedicated matches table for cleaner tracking
CREATE TABLE IF NOT EXISTS user_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user1_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user2_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    match_type VARCHAR(50) DEFAULT 'regular',
    matched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_via VARCHAR(50) DEFAULT 'matchmaking',
    UNIQUE(user1_id, user2_id)
);

-- Create indexes for the matches table
CREATE INDEX IF NOT EXISTS idx_user_matches_user1 ON user_matches(user1_id);
CREATE INDEX IF NOT EXISTS idx_user_matches_user2 ON user_matches(user2_id);
CREATE INDEX IF NOT EXISTS idx_user_matches_matched_at ON user_matches(matched_at);

-- Update the update_user_stats function to use the new matches table as fallback
CREATE OR REPLACE FUNCTION update_user_stats(user_uuid UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE profiles 
  SET 
    total_matches = (
      -- First try matchmaking_proposals table
      SELECT COUNT(*) 
      FROM matchmaking_proposals 
      WHERE (a = user_uuid OR b = user_uuid) 
      AND status = 'matched'
    ) + (
      -- Add matches from user_matches table
      SELECT COUNT(*) 
      FROM user_matches 
      WHERE (user1_id = user_uuid OR user2_id = user_uuid)
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
    -- If tables don't exist, update other stats and set matches to 0
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
