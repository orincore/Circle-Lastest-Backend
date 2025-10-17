-- Migration: Create explore_interactions table for tracking user actions in explore page
-- Created: 2025-01-17
-- Purpose: Track match, pass, and super_like actions from explore page

-- Create explore_interactions table
CREATE TABLE IF NOT EXISTS explore_interactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    action_type TEXT NOT NULL CHECK (action_type IN ('view', 'like', 'super_like', 'pass')),
    interaction_source TEXT DEFAULT 'explore' CHECK (interaction_source IN ('explore', 'search', 'profile_view')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Prevent duplicate interactions within short time
    CONSTRAINT unique_recent_interaction UNIQUE (user_id, target_user_id, action_type, created_at)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_explore_interactions_user_id 
ON explore_interactions(user_id);

CREATE INDEX IF NOT EXISTS idx_explore_interactions_target_user_id 
ON explore_interactions(target_user_id);

CREATE INDEX IF NOT EXISTS idx_explore_interactions_user_target 
ON explore_interactions(user_id, target_user_id);

CREATE INDEX IF NOT EXISTS idx_explore_interactions_created_at 
ON explore_interactions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_explore_interactions_action_type 
ON explore_interactions(action_type);

-- Add action_source column to matchmaking_proposals if not exists
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'matchmaking_proposals' 
        AND column_name = 'action_source'
    ) THEN
        ALTER TABLE matchmaking_proposals 
        ADD COLUMN action_source TEXT DEFAULT 'match_tab' 
        CHECK (action_source IN ('match_tab', 'explore_tab', 'profile_view'));
    END IF;
END $$;

-- Create function to get user's recent explore actions
CREATE OR REPLACE FUNCTION get_user_explore_actions(
    p_user_id UUID,
    p_days_back INT DEFAULT 30
)
RETURNS TABLE (
    target_user_id UUID,
    action_type TEXT,
    interaction_count BIGINT,
    last_interaction TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        ei.target_user_id,
        ei.action_type,
        COUNT(*) as interaction_count,
        MAX(ei.created_at) as last_interaction
    FROM explore_interactions ei
    WHERE ei.user_id = p_user_id
        AND ei.created_at >= NOW() - (p_days_back || ' days')::INTERVAL
    GROUP BY ei.target_user_id, ei.action_type
    ORDER BY last_interaction DESC;
END;
$$ LANGUAGE plpgsql;

-- Create function to get explore analytics
CREATE OR REPLACE FUNCTION get_explore_analytics(
    p_user_id UUID DEFAULT NULL,
    p_days_back INT DEFAULT 7
)
RETURNS TABLE (
    total_views BIGINT,
    total_likes BIGINT,
    total_super_likes BIGINT,
    total_passes BIGINT,
    unique_users_viewed BIGINT,
    conversion_rate NUMERIC
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(*) FILTER (WHERE action_type = 'view') as total_views,
        COUNT(*) FILTER (WHERE action_type = 'like') as total_likes,
        COUNT(*) FILTER (WHERE action_type = 'super_like') as total_super_likes,
        COUNT(*) FILTER (WHERE action_type = 'pass') as total_passes,
        COUNT(DISTINCT target_user_id) as unique_users_viewed,
        CASE 
            WHEN COUNT(*) FILTER (WHERE action_type = 'view') > 0 
            THEN ROUND(
                (COUNT(*) FILTER (WHERE action_type IN ('like', 'super_like'))::NUMERIC / 
                 COUNT(*) FILTER (WHERE action_type = 'view')::NUMERIC) * 100, 
                2
            )
            ELSE 0
        END as conversion_rate
    FROM explore_interactions
    WHERE (p_user_id IS NULL OR user_id = p_user_id)
        AND created_at >= NOW() - (p_days_back || ' days')::INTERVAL;
END;
$$ LANGUAGE plpgsql;

-- Create function to clean up old interactions (optional, for maintenance)
CREATE OR REPLACE FUNCTION cleanup_old_explore_interactions(
    p_days_to_keep INT DEFAULT 90
)
RETURNS BIGINT AS $$
DECLARE
    deleted_count BIGINT;
BEGIN
    DELETE FROM explore_interactions
    WHERE created_at < NOW() - (p_days_to_keep || ' days')::INTERVAL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Add RLS (Row Level Security) policies
ALTER TABLE explore_interactions ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own interactions
CREATE POLICY explore_interactions_select_own 
ON explore_interactions FOR SELECT 
USING (auth.uid() = user_id);

-- Policy: Users can insert their own interactions
CREATE POLICY explore_interactions_insert_own 
ON explore_interactions FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Policy: Users can delete their own interactions
CREATE POLICY explore_interactions_delete_own 
ON explore_interactions FOR DELETE 
USING (auth.uid() = user_id);

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON explore_interactions TO authenticated;
GRANT EXECUTE ON FUNCTION get_user_explore_actions(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_explore_analytics(UUID, INT) TO authenticated;

-- Add comments for documentation
COMMENT ON TABLE explore_interactions IS 'Tracks user interactions (view, like, super_like, pass) from the explore page';
COMMENT ON COLUMN explore_interactions.action_type IS 'Type of interaction: view, like, super_like, pass';
COMMENT ON COLUMN explore_interactions.interaction_source IS 'Source of interaction: explore, search, profile_view';
COMMENT ON FUNCTION get_user_explore_actions(UUID, INT) IS 'Get a user''s recent explore actions grouped by target user and action type';
COMMENT ON FUNCTION get_explore_analytics(UUID, INT) IS 'Get explore page analytics including views, likes, and conversion rates';
COMMENT ON FUNCTION cleanup_old_explore_interactions(INT) IS 'Clean up explore interactions older than specified days';

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Migration 049: explore_interactions table created successfully';
    RAISE NOTICE 'Indexes, functions, and RLS policies have been applied';
    RAISE NOTICE 'Run: SELECT * FROM get_explore_analytics() to view platform-wide analytics';
END $$;
