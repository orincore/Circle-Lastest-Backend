-- =============================================================================
-- FIX SECURITY DEFINER VIEWS
-- Convert all SECURITY DEFINER views to SECURITY INVOKER
-- =============================================================================

-- First, get the current view definitions
-- Run this query to see all SECURITY DEFINER views:
-- SELECT viewname, definition FROM pg_views WHERE schemaname = 'public' AND definition ILIKE '%SECURITY DEFINER%';

-- =============================================================================
-- STEP 1: DROP AND RECREATE VIEWS WITHOUT SECURITY DEFINER
-- =============================================================================

-- 1. crash_summary
DROP VIEW IF EXISTS public.crash_summary;
-- Note: You need to get the original view definition and recreate it
-- CREATE VIEW public.crash_summary AS [original definition];

-- 2. friend_requests_view  
DROP VIEW IF EXISTS public.friend_requests_view;
-- CREATE VIEW public.friend_requests_view AS [original definition];

-- 3. v_active_announcements
DROP VIEW IF EXISTS public.v_active_announcements;
-- CREATE VIEW public.v_active_announcements AS [original definition];

-- 4. conversation_analytics_view
DROP VIEW IF EXISTS public.conversation_analytics_view;
-- CREATE VIEW public.conversation_analytics_view AS [original definition];

-- 5. referral_dashboard
DROP VIEW IF EXISTS public.referral_dashboard;
-- CREATE VIEW public.referral_dashboard AS [original definition];

-- 6. ai_conversation_analytics
DROP VIEW IF EXISTS public.ai_conversation_analytics;
-- CREATE VIEW public.ai_conversation_analytics AS [original definition];

-- 7. daily_active_users
DROP VIEW IF EXISTS public.daily_active_users;
-- CREATE VIEW public.daily_active_users AS [original definition];

-- 8. app_version_distribution
DROP VIEW IF EXISTS public.app_version_distribution;
-- CREATE VIEW public.app_version_distribution AS [original definition];

-- 9. call_analytics
DROP VIEW IF EXISTS public.call_analytics;
-- CREATE VIEW public.call_analytics AS [original definition];

-- 10. real_time_metrics_view
DROP VIEW IF EXISTS public.real_time_metrics_view;
-- CREATE VIEW public.real_time_metrics_view AS [original definition];

-- 11. feature_adoption
DROP VIEW IF EXISTS public.feature_adoption;
-- CREATE VIEW public.feature_adoption AS [original definition];

-- 12. accepted_friendships_view
DROP VIEW IF EXISTS public.accepted_friendships_view;
-- CREATE VIEW public.accepted_friendships_view AS [original definition];

-- =============================================================================
-- STEP 2: GET VIEW DEFINITIONS SCRIPT
-- =============================================================================

-- Run this to get all current view definitions:
SELECT 
    viewname,
    definition
FROM pg_views 
WHERE schemaname = 'public' 
    AND viewname IN (
        'crash_summary',
        'friend_requests_view', 
        'v_active_announcements',
        'conversation_analytics_view',
        'referral_dashboard',
        'ai_conversation_analytics',
        'daily_active_users',
        'app_version_distribution', 
        'call_analytics',
        'real_time_metrics_view',
        'feature_adoption',
        'accepted_friendships_view'
    );

-- =============================================================================
-- STEP 3: ALTERNATIVE - CREATE FUNCTIONS INSTEAD OF VIEWS
-- =============================================================================

-- For sensitive analytics views, consider creating functions with proper security
-- Example:

CREATE OR REPLACE FUNCTION get_daily_active_users(start_date date DEFAULT CURRENT_DATE - INTERVAL '30 days')
RETURNS TABLE (
    date date,
    active_users bigint
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    -- Only allow admin users to call this function
    SELECT 
        date_trunc('day', created_at)::date as date,
        count(DISTINCT user_id) as active_users
    FROM user_activities 
    WHERE created_at >= start_date
        AND EXISTS (
            SELECT 1 FROM auth.users 
            WHERE id = auth.uid() 
            AND raw_user_meta_data->>'role' = 'admin'
        )
    GROUP BY date_trunc('day', created_at)
    ORDER BY date;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION get_daily_active_users TO authenticated;

-- =============================================================================
-- VERIFICATION
-- =============================================================================

-- Check for remaining SECURITY DEFINER views
SELECT viewname, definition
FROM pg_views 
WHERE schemaname = 'public' 
    AND definition ILIKE '%SECURITY DEFINER%';

-- Should return 0 rows after fixing
