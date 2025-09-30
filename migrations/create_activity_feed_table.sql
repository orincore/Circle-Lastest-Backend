-- Create activity_feed table for live activity tracking
CREATE TABLE IF NOT EXISTS activity_feed (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data JSONB NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_activity_feed_timestamp ON activity_feed(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_feed_type ON activity_feed(type);
CREATE INDEX IF NOT EXISTS idx_activity_feed_user_id ON activity_feed(user_id);

-- Add RLS (Row Level Security) policies if needed
-- ALTER TABLE activity_feed ENABLE ROW LEVEL SECURITY;

-- Optional: Create a function to clean up old activities (keep only last 1000)
CREATE OR REPLACE FUNCTION cleanup_old_activities()
RETURNS void AS $$
BEGIN
  DELETE FROM activity_feed 
  WHERE id NOT IN (
    SELECT id FROM activity_feed 
    ORDER BY timestamp DESC 
    LIMIT 1000
  );
END;
$$ LANGUAGE plpgsql;

-- Optional: Create a trigger to automatically cleanup old activities
-- CREATE OR REPLACE FUNCTION trigger_cleanup_activities()
-- RETURNS trigger AS $$
-- BEGIN
--   -- Only cleanup every 100 inserts to avoid performance impact
--   IF (SELECT COUNT(*) FROM activity_feed) % 100 = 0 THEN
--     PERFORM cleanup_old_activities();
--   END IF;
--   RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;

-- CREATE TRIGGER activity_cleanup_trigger
--   AFTER INSERT ON activity_feed
--   FOR EACH ROW
--   EXECUTE FUNCTION trigger_cleanup_activities();

COMMENT ON TABLE activity_feed IS 'Stores live activity events for the activity feed feature';
COMMENT ON COLUMN activity_feed.id IS 'Unique identifier for the activity';
COMMENT ON COLUMN activity_feed.type IS 'Type of activity (user_matched, user_joined, etc.)';
COMMENT ON COLUMN activity_feed.data IS 'JSON data containing activity details';
COMMENT ON COLUMN activity_feed.timestamp IS 'When the activity occurred';
COMMENT ON COLUMN activity_feed.user_id IS 'User who performed the activity (optional)';
