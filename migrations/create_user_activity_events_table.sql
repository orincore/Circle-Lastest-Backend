-- Create user activity events table for detailed analytics tracking
CREATE TABLE IF NOT EXISTS user_activity_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  session_id TEXT,
  properties JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_user_activity_events_user_id ON user_activity_events(user_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_events_event_name ON user_activity_events(event_name);
CREATE INDEX IF NOT EXISTS idx_user_activity_events_session_id ON user_activity_events(session_id);
CREATE INDEX IF NOT EXISTS idx_user_activity_events_created_at ON user_activity_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_activity_events_user_created ON user_activity_events(user_id, created_at DESC);

-- Create composite index for common queries
CREATE INDEX IF NOT EXISTS idx_user_activity_events_user_event_date 
ON user_activity_events(user_id, event_name, created_at DESC);

-- Add GIN index for JSONB properties for efficient property searches
CREATE INDEX IF NOT EXISTS idx_user_activity_events_properties 
ON user_activity_events USING GIN (properties);

-- Enable Row Level Security (RLS)
ALTER TABLE user_activity_events ENABLE ROW LEVEL SECURITY;

-- Create policy: Users can only see their own events
CREATE POLICY user_activity_events_select_policy ON user_activity_events
  FOR SELECT
  USING (auth.uid() = user_id);

-- Create policy: Users can insert their own events
CREATE POLICY user_activity_events_insert_policy ON user_activity_events
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Create policy: Admins can see all events
CREATE POLICY user_activity_events_admin_policy ON user_activity_events
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles 
      WHERE user_id = auth.uid()
    )
  );

-- Add comments for documentation
COMMENT ON TABLE user_activity_events IS 'Stores detailed user activity events for analytics and behavior tracking';
COMMENT ON COLUMN user_activity_events.event_name IS 'Type of event (e.g., screen_view, button_click, match_action)';
COMMENT ON COLUMN user_activity_events.session_id IS 'Unique identifier for the user session';
COMMENT ON COLUMN user_activity_events.properties IS 'Additional event properties stored as JSON';

-- Create materialized view for daily active users (for faster queries)
CREATE MATERIALIZED VIEW IF NOT EXISTS daily_active_users AS
SELECT 
  DATE(created_at) as date,
  COUNT(DISTINCT user_id) as active_users,
  COUNT(*) as total_events
FROM user_activity_events
WHERE event_name = 'session_start'
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Create index on materialized view
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_active_users_date ON daily_active_users(date);

-- Create function to refresh materialized view
CREATE OR REPLACE FUNCTION refresh_daily_active_users()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY daily_active_users;
END;
$$ LANGUAGE plpgsql;

-- Create materialized view for popular features
CREATE MATERIALIZED VIEW IF NOT EXISTS popular_features AS
SELECT 
  properties->>'feature' as feature_name,
  COUNT(*) as usage_count,
  COUNT(DISTINCT user_id) as unique_users,
  DATE(created_at) as date
FROM user_activity_events
WHERE event_name = 'feature_usage'
  AND properties->>'feature' IS NOT NULL
GROUP BY properties->>'feature', DATE(created_at)
ORDER BY usage_count DESC;

-- Create index on popular features view
CREATE INDEX IF NOT EXISTS idx_popular_features_date ON popular_features(date);
CREATE INDEX IF NOT EXISTS idx_popular_features_count ON popular_features(usage_count DESC);

-- Create function to refresh popular features view
CREATE OR REPLACE FUNCTION refresh_popular_features()
RETURNS void AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY popular_features;
END;
$$ LANGUAGE plpgsql;

-- Create a function to get user engagement score
CREATE OR REPLACE FUNCTION get_user_engagement_score(p_user_id UUID, p_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  v_score INTEGER := 0;
  v_session_count INTEGER;
  v_event_count INTEGER;
  v_unique_features INTEGER;
BEGIN
  -- Count sessions
  SELECT COUNT(DISTINCT session_id) INTO v_session_count
  FROM user_activity_events
  WHERE user_id = p_user_id
    AND created_at >= NOW() - (p_days || ' days')::INTERVAL
    AND event_name = 'session_start';
  
  -- Count total events
  SELECT COUNT(*) INTO v_event_count
  FROM user_activity_events
  WHERE user_id = p_user_id
    AND created_at >= NOW() - (p_days || ' days')::INTERVAL;
  
  -- Count unique features used
  SELECT COUNT(DISTINCT properties->>'feature') INTO v_unique_features
  FROM user_activity_events
  WHERE user_id = p_user_id
    AND created_at >= NOW() - (p_days || ' days')::INTERVAL
    AND event_name = 'feature_usage';
  
  -- Calculate score
  v_score := (v_session_count * 10) + (v_event_count * 1) + (v_unique_features * 20);
  
  RETURN v_score;
END;
$$ LANGUAGE plpgsql;

-- Create a function to get user activity summary
CREATE OR REPLACE FUNCTION get_user_activity_summary(p_user_id UUID, p_days INTEGER DEFAULT 7)
RETURNS TABLE (
  total_events BIGINT,
  total_sessions BIGINT,
  avg_session_duration NUMERIC,
  most_used_feature TEXT,
  last_active TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    (SELECT COUNT(*) FROM user_activity_events 
     WHERE user_id = p_user_id 
       AND created_at >= NOW() - (p_days || ' days')::INTERVAL) as total_events,
    
    (SELECT COUNT(DISTINCT session_id) FROM user_activity_events 
     WHERE user_id = p_user_id 
       AND created_at >= NOW() - (p_days || ' days')::INTERVAL
       AND event_name = 'session_start') as total_sessions,
    
    (SELECT AVG((properties->>'duration_seconds')::NUMERIC) FROM user_activity_events 
     WHERE user_id = p_user_id 
       AND created_at >= NOW() - (p_days || ' days')::INTERVAL
       AND event_name = 'session_end') as avg_session_duration,
    
    (SELECT properties->>'feature' FROM user_activity_events 
     WHERE user_id = p_user_id 
       AND created_at >= NOW() - (p_days || ' days')::INTERVAL
       AND event_name = 'feature_usage'
     GROUP BY properties->>'feature'
     ORDER BY COUNT(*) DESC
     LIMIT 1) as most_used_feature,
    
    (SELECT MAX(created_at) FROM user_activity_events 
     WHERE user_id = p_user_id) as last_active;
END;
$$ LANGUAGE plpgsql;

-- Grant permissions
GRANT SELECT ON user_activity_events TO authenticated;
GRANT INSERT ON user_activity_events TO authenticated;
GRANT SELECT ON daily_active_users TO authenticated;
GRANT SELECT ON popular_features TO authenticated;
