-- Analytics and Tracking Tables Migration
-- This migration creates tables for analytics events, app versions, and crash reports

-- =====================================================
-- 1. ANALYTICS EVENTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS analytics_events (
  id BIGSERIAL PRIMARY KEY,
  event_name VARCHAR(100) NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  session_id VARCHAR(100),
  timestamp TIMESTAMPTZ NOT NULL,
  properties JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for analytics_events
CREATE INDEX IF NOT EXISTS idx_analytics_events_event_name ON analytics_events(event_name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_user_id ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_session_id ON analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp ON analytics_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at);

-- GIN index for JSONB properties
CREATE INDEX IF NOT EXISTS idx_analytics_events_properties ON analytics_events USING GIN(properties);

-- =====================================================
-- 2. APP VERSIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS app_versions (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  version VARCHAR(20) NOT NULL,
  build_number VARCHAR(20) NOT NULL,
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  expo_version VARCHAR(20),
  device_id VARCHAR(100),
  device_name VARCHAR(200),
  device_model VARCHAR(100),
  os_version VARCHAR(50),
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for app_versions
CREATE INDEX IF NOT EXISTS idx_app_versions_user_id ON app_versions(user_id);
CREATE INDEX IF NOT EXISTS idx_app_versions_version ON app_versions(version);
CREATE INDEX IF NOT EXISTS idx_app_versions_platform ON app_versions(platform);
CREATE INDEX IF NOT EXISTS idx_app_versions_device_id ON app_versions(device_id);
CREATE INDEX IF NOT EXISTS idx_app_versions_created_at ON app_versions(created_at);

-- Composite index for version analytics
CREATE INDEX IF NOT EXISTS idx_app_versions_version_platform ON app_versions(version, platform);

-- =====================================================
-- 3. CRASH REPORTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS crash_reports (
  id BIGSERIAL PRIMARY KEY,
  crash_id VARCHAR(100) UNIQUE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  session_id VARCHAR(100),
  timestamp TIMESTAMPTZ NOT NULL,
  type VARCHAR(50) NOT NULL,
  is_fatal BOOLEAN DEFAULT FALSE,
  
  -- Error details
  error_name VARCHAR(200) NOT NULL,
  error_message TEXT NOT NULL,
  error_stack TEXT,
  
  -- Device information
  device_platform VARCHAR(20) NOT NULL,
  device_version VARCHAR(50),
  device_model VARCHAR(100),
  device_name VARCHAR(200),
  
  -- App information
  app_version VARCHAR(20) NOT NULL,
  build_number VARCHAR(20) NOT NULL,
  expo_version VARCHAR(20),
  is_device BOOLEAN DEFAULT TRUE,
  
  -- Additional context
  breadcrumbs JSONB DEFAULT '[]',
  user_context JSONB DEFAULT '{}',
  
  -- Metadata
  resolved BOOLEAN DEFAULT FALSE,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  notes TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for crash_reports
CREATE INDEX IF NOT EXISTS idx_crash_reports_crash_id ON crash_reports(crash_id);
CREATE INDEX IF NOT EXISTS idx_crash_reports_user_id ON crash_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_crash_reports_session_id ON crash_reports(session_id);
CREATE INDEX IF NOT EXISTS idx_crash_reports_timestamp ON crash_reports(timestamp);
CREATE INDEX IF NOT EXISTS idx_crash_reports_type ON crash_reports(type);
CREATE INDEX IF NOT EXISTS idx_crash_reports_is_fatal ON crash_reports(is_fatal);
CREATE INDEX IF NOT EXISTS idx_crash_reports_device_platform ON crash_reports(device_platform);
CREATE INDEX IF NOT EXISTS idx_crash_reports_app_version ON crash_reports(app_version);
CREATE INDEX IF NOT EXISTS idx_crash_reports_resolved ON crash_reports(resolved);
CREATE INDEX IF NOT EXISTS idx_crash_reports_created_at ON crash_reports(created_at);

-- GIN indexes for JSONB columns
CREATE INDEX IF NOT EXISTS idx_crash_reports_breadcrumbs ON crash_reports USING GIN(breadcrumbs);
CREATE INDEX IF NOT EXISTS idx_crash_reports_user_context ON crash_reports USING GIN(user_context);

-- =====================================================
-- 4. USER SESSIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS user_sessions (
  id BIGSERIAL PRIMARY KEY,
  session_id VARCHAR(100) UNIQUE NOT NULL,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  
  -- Session details
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  
  -- Device information
  platform VARCHAR(20) NOT NULL,
  app_version VARCHAR(20) NOT NULL,
  device_id VARCHAR(100),
  device_name VARCHAR(200),
  
  -- Session metrics
  screen_views INTEGER DEFAULT 0,
  events_count INTEGER DEFAULT 0,
  crashes_count INTEGER DEFAULT 0,
  
  -- Location (optional)
  country VARCHAR(2),
  city VARCHAR(100),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for user_sessions
CREATE INDEX IF NOT EXISTS idx_user_sessions_session_id ON user_sessions(session_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_started_at ON user_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_platform ON user_sessions(platform);
CREATE INDEX IF NOT EXISTS idx_user_sessions_app_version ON user_sessions(app_version);

-- =====================================================
-- 5. USER CONSENT TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS user_consent (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  
  -- Consent details
  analytics_consent BOOLEAN DEFAULT FALSE,
  crash_reporting_consent BOOLEAN DEFAULT FALSE,
  personalization_consent BOOLEAN DEFAULT FALSE,
  marketing_consent BOOLEAN DEFAULT FALSE,
  
  -- Metadata
  consent_version VARCHAR(10) DEFAULT '1.0',
  consent_timestamp TIMESTAMPTZ NOT NULL,
  ip_address INET,
  user_agent TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Ensure one consent record per user (latest)
  UNIQUE(user_id)
);

-- Indexes for user_consent
CREATE INDEX IF NOT EXISTS idx_user_consent_user_id ON user_consent(user_id);
CREATE INDEX IF NOT EXISTS idx_user_consent_timestamp ON user_consent(consent_timestamp);

-- =====================================================
-- 6. FEATURE USAGE TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS feature_usage (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  feature_name VARCHAR(100) NOT NULL,
  
  -- Usage metrics
  first_used_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  usage_count INTEGER DEFAULT 1,
  total_time_seconds INTEGER DEFAULT 0,
  
  -- Feature-specific data
  feature_data JSONB DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Unique constraint for user-feature combination
  UNIQUE(user_id, feature_name)
);

-- Indexes for feature_usage
CREATE INDEX IF NOT EXISTS idx_feature_usage_user_id ON feature_usage(user_id);
CREATE INDEX IF NOT EXISTS idx_feature_usage_feature_name ON feature_usage(feature_name);
CREATE INDEX IF NOT EXISTS idx_feature_usage_last_used_at ON feature_usage(last_used_at);

-- =====================================================
-- 7. TRIGGERS FOR UPDATED_AT TIMESTAMPS
-- =====================================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for all tables
CREATE TRIGGER update_analytics_events_updated_at 
    BEFORE UPDATE ON analytics_events 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_app_versions_updated_at 
    BEFORE UPDATE ON app_versions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_crash_reports_updated_at 
    BEFORE UPDATE ON crash_reports 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_sessions_updated_at 
    BEFORE UPDATE ON user_sessions 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_consent_updated_at 
    BEFORE UPDATE ON user_consent 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_feature_usage_updated_at 
    BEFORE UPDATE ON feature_usage 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 8. USEFUL VIEWS FOR ANALYTICS
-- =====================================================

-- Drop existing views/materialized views if they exist
DROP MATERIALIZED VIEW IF EXISTS daily_active_users CASCADE;
DROP MATERIALIZED VIEW IF EXISTS app_version_distribution CASCADE;
DROP MATERIALIZED VIEW IF EXISTS crash_summary CASCADE;
DROP MATERIALIZED VIEW IF EXISTS feature_adoption CASCADE;

DROP VIEW IF EXISTS daily_active_users CASCADE;
DROP VIEW IF EXISTS app_version_distribution CASCADE;
DROP VIEW IF EXISTS crash_summary CASCADE;
DROP VIEW IF EXISTS feature_adoption CASCADE;

-- Daily active users view
CREATE VIEW daily_active_users AS
SELECT 
    DATE(created_at) as date,
    COUNT(DISTINCT user_id) as active_users,
    COUNT(*) as total_events
FROM analytics_events 
WHERE user_id IS NOT NULL
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- App version distribution view
CREATE VIEW app_version_distribution AS
SELECT 
    version,
    platform,
    COUNT(DISTINCT user_id) as user_count,
    COUNT(*) as install_count,
    MAX(created_at) as latest_install
FROM app_versions
GROUP BY version, platform
ORDER BY latest_install DESC;

-- Crash summary view
CREATE VIEW crash_summary AS
SELECT 
    DATE(created_at) as date,
    COUNT(*) as total_crashes,
    COUNT(CASE WHEN is_fatal THEN 1 END) as fatal_crashes,
    COUNT(DISTINCT user_id) as affected_users,
    app_version,
    device_platform
FROM crash_reports
GROUP BY DATE(created_at), app_version, device_platform
ORDER BY date DESC;

-- Feature adoption view
CREATE VIEW feature_adoption AS
SELECT 
    feature_name,
    COUNT(DISTINCT user_id) as unique_users,
    SUM(usage_count) as total_usage,
    AVG(usage_count) as avg_usage_per_user,
    SUM(total_time_seconds) as total_time_seconds
FROM feature_usage
GROUP BY feature_name
ORDER BY unique_users DESC;

-- =====================================================
-- 9. ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE crash_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_usage ENABLE ROW LEVEL SECURITY;

-- Policies for analytics_events
CREATE POLICY "Users can view their own analytics events" ON analytics_events
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all analytics events" ON analytics_events
    FOR ALL USING (auth.role() = 'service_role');

-- Policies for app_versions
CREATE POLICY "Users can view their own app versions" ON app_versions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all app versions" ON app_versions
    FOR ALL USING (auth.role() = 'service_role');

-- Policies for crash_reports
CREATE POLICY "Users can view their own crash reports" ON crash_reports
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all crash reports" ON crash_reports
    FOR ALL USING (auth.role() = 'service_role');

-- Policies for user_sessions
CREATE POLICY "Users can view their own sessions" ON user_sessions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all sessions" ON user_sessions
    FOR ALL USING (auth.role() = 'service_role');

-- Policies for user_consent
CREATE POLICY "Users can manage their own consent" ON user_consent
    FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Service role can view all consent records" ON user_consent
    FOR SELECT USING (auth.role() = 'service_role');

-- Policies for feature_usage
CREATE POLICY "Users can view their own feature usage" ON feature_usage
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage all feature usage" ON feature_usage
    FOR ALL USING (auth.role() = 'service_role');

-- =====================================================
-- 10. HELPFUL FUNCTIONS
-- =====================================================

-- Function to get user analytics summary
CREATE OR REPLACE FUNCTION get_user_analytics_summary(target_user_id UUID)
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'total_events', COUNT(*),
        'unique_sessions', COUNT(DISTINCT session_id),
        'first_event', MIN(timestamp),
        'last_event', MAX(timestamp),
        'top_events', (
            SELECT json_agg(json_build_object('event', event_name, 'count', count))
            FROM (
                SELECT event_name, COUNT(*) as count
                FROM analytics_events 
                WHERE user_id = target_user_id
                GROUP BY event_name
                ORDER BY count DESC
                LIMIT 5
            ) top_events
        )
    ) INTO result
    FROM analytics_events
    WHERE user_id = target_user_id;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to clean up old analytics data
CREATE OR REPLACE FUNCTION cleanup_old_analytics_data(days_to_keep INTEGER DEFAULT 90)
RETURNS INTEGER AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete old analytics events
    DELETE FROM analytics_events 
    WHERE created_at < NOW() - INTERVAL '1 day' * days_to_keep;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Delete old app version records (keep only latest per user/platform)
    DELETE FROM app_versions av1
    WHERE EXISTS (
        SELECT 1 FROM app_versions av2
        WHERE av2.user_id = av1.user_id 
        AND av2.platform = av1.platform
        AND av2.created_at > av1.created_at
    ) AND av1.created_at < NOW() - INTERVAL '1 day' * 30;
    
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- COMMENTS FOR DOCUMENTATION
-- =====================================================

COMMENT ON TABLE analytics_events IS 'Stores all user interaction events for analytics';
COMMENT ON TABLE app_versions IS 'Tracks app version installations and updates';
COMMENT ON TABLE crash_reports IS 'Stores application crash reports and error details';
COMMENT ON TABLE user_sessions IS 'Tracks user session information and metrics';
COMMENT ON TABLE user_consent IS 'Stores user consent preferences for GDPR compliance';
COMMENT ON TABLE feature_usage IS 'Tracks individual feature usage statistics';

COMMENT ON VIEW daily_active_users IS 'Daily active user counts and event totals';
COMMENT ON VIEW app_version_distribution IS 'Distribution of app versions across platforms';
COMMENT ON VIEW crash_summary IS 'Daily crash statistics by version and platform';
COMMENT ON VIEW feature_adoption IS 'Feature usage and adoption metrics';

-- =====================================================
-- SAMPLE DATA (OPTIONAL - FOR TESTING)
-- =====================================================

-- Uncomment the following to insert sample data for testing
/*
-- Sample analytics events
INSERT INTO analytics_events (event_name, user_id, session_id, timestamp, properties) VALUES
('app_launched', '00000000-0000-0000-0000-000000000001', 'session_1', NOW(), '{"platform": "ios"}'),
('screen_view', '00000000-0000-0000-0000-000000000001', 'session_1', NOW(), '{"screen_name": "home"}'),
('button_click', '00000000-0000-0000-0000-000000000001', 'session_1', NOW(), '{"button": "match_button"}');

-- Sample app version
INSERT INTO app_versions (user_id, version, build_number, platform, timestamp) VALUES
('00000000-0000-0000-0000-000000000001', '1.0.0', '1', 'ios', NOW());

-- Sample user consent
INSERT INTO user_consent (user_id, analytics_consent, crash_reporting_consent, consent_timestamp) VALUES
('00000000-0000-0000-0000-000000000001', true, true, NOW());
*/
