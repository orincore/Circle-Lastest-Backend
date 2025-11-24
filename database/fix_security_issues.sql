-- =============================================================================
-- SUPABASE SECURITY FIXES
-- Fix all RLS and Security Definer issues identified by Supabase Linter
-- =============================================================================

-- 1. ENABLE RLS ON ALL PUBLIC TABLES
-- =============================================================================

-- Core messaging tables
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_deletions ENABLE ROW LEVEL SECURITY;

-- User relationship tables
ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matchmaking_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matchmaking_proposals ENABLE ROW LEVEL SECURITY;

-- Voice call tables
ALTER TABLE public.voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_call_participants ENABLE ROW LEVEL SECURITY;

-- Subscription and payment tables
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.promotional_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_match_limits ENABLE ROW LEVEL SECURITY;

-- User activity and analytics tables
ALTER TABLE public.user_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profile_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_analytics ENABLE ROW LEVEL SECURITY;

-- Notification and communication tables
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

-- Marketing and campaign tables
ALTER TABLE public.marketing_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_campaign_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_marketing_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_segments ENABLE ROW LEVEL SECURITY;

-- Referral system tables
ALTER TABLE public.user_referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.referral_code_attempts ENABLE ROW LEVEL SECURITY;

-- Verification and security tables
ALTER TABLE public.face_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verification_attempts ENABLE ROW LEVEL SECURITY;

-- Feedback and support tables
ALTER TABLE public.satisfaction_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.satisfaction_surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.escalation_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback_analysis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.proactive_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_capabilities ENABLE ROW LEVEL SECURITY;

-- Cache and stats tables
ALTER TABLE public.explore_cache_stats ENABLE ROW LEVEL SECURITY;

-- 2. CREATE BASIC RLS POLICIES FOR USER-OWNED DATA
-- =============================================================================

-- Messages: Users can only see messages in chats they're members of
CREATE POLICY "Users can view messages in their chats" ON public.messages
    FOR SELECT USING (
        chat_id IN (
            SELECT chat_id FROM public.chat_members 
            WHERE user_id::text = auth.uid()::text
        )
    );

CREATE POLICY "Users can insert messages in their chats" ON public.messages
    FOR INSERT WITH CHECK (
        sender_id::text = auth.uid()::text AND
        chat_id IN (
            SELECT chat_id FROM public.chat_members 
            WHERE user_id::text = auth.uid()::text
        )
    );

-- Chats: Users can only see chats they're members of
CREATE POLICY "Users can view their chats" ON public.chats
    FOR SELECT USING (
        id IN (
            SELECT chat_id FROM public.chat_members 
            WHERE user_id::text = auth.uid()::text
        )
    );

-- Chat members: Users can see memberships in their chats
CREATE POLICY "Users can view chat members in their chats" ON public.chat_members
    FOR SELECT USING (
        chat_id IN (
            SELECT chat_id FROM public.chat_members 
            WHERE user_id::text = auth.uid()::text
        )
    );

-- Friendships: Users can only see their own friendships
DROP POLICY IF EXISTS "Users can view their friendships" ON public.friendships;

CREATE POLICY "Users can view their friendships" ON public.friendships
    FOR ALL USING (
        user1_id::text = auth.uid()::text OR user2_id::text = auth.uid()::text
    );

-- User matches: Users can only see their own matches
DROP POLICY IF EXISTS "Users can view their matches" ON public.user_matches;

CREATE POLICY "Users can view their matches" ON public.user_matches
    FOR ALL USING (
        user1_id::text = auth.uid()::text OR user2_id::text = auth.uid()::text
    );

-- Voice calls: Users can only see calls they participated in
CREATE POLICY "Users can view their voice calls" ON public.voice_calls
    FOR SELECT USING (
        id IN (
            SELECT call_id FROM public.voice_call_participants 
            WHERE user_id::text = auth.uid()::text
        )
    );

-- Voice call participants: Users can see participants in their calls
CREATE POLICY "Users can view participants in their calls" ON public.voice_call_participants
    FOR SELECT USING (
        call_id IN (
            SELECT call_id FROM public.voice_call_participants 
            WHERE user_id::text = auth.uid()::text
        )
    );

-- User subscriptions: Users can only see their own subscriptions
CREATE POLICY "Users can view their subscriptions" ON public.user_subscriptions
    FOR ALL USING (user_id::text = auth.uid()::text);

-- Push tokens: Users can only manage their own tokens
CREATE POLICY "Users can manage their push tokens" ON public.push_tokens
    FOR ALL USING (user_id::text = auth.uid()::text);

-- User activities: Users can only see their own activities
CREATE POLICY "Users can view their activities" ON public.user_activities
    FOR ALL USING (user_id::text = auth.uid()::text);

-- User referrals: Users can only see their own referrals
CREATE POLICY "Users can view their referrals" ON public.user_referrals
    FOR ALL USING (
        referrer_id::text = auth.uid()::text OR
        referred_id::text = auth.uid()::text
    );

-- Face verifications: Users can only see their own verifications
CREATE POLICY "Users can view their verifications" ON public.face_verifications
    FOR ALL USING (user_id::text = auth.uid()::text);

-- Satisfaction ratings: Users can only see their own ratings
CREATE POLICY "Users can view their ratings" ON public.satisfaction_ratings
    FOR ALL USING (user_id::text = auth.uid()::text);

-- 3. ADMIN-ONLY POLICIES FOR SYSTEM TABLES
-- =============================================================================

-- Marketing campaigns: Admin only
CREATE POLICY "Admin can manage marketing campaigns" ON public.marketing_campaigns
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM auth.users 
            WHERE id::text = auth.uid()::text 
            AND raw_user_meta_data->>'role' = 'admin'
        )
    );

-- Email templates: Admin only
CREATE POLICY "Admin can manage email templates" ON public.email_templates
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM auth.users 
            WHERE id::text = auth.uid()::text 
            AND raw_user_meta_data->>'role' = 'admin'
        )
    );

-- Announcements: Admin can manage, users can read
CREATE POLICY "Users can view active announcements" ON public.announcements
    FOR SELECT USING (is_active = true);

CREATE POLICY "Admin can manage announcements" ON public.announcements
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM auth.users 
            WHERE id::text = auth.uid()::text 
            AND raw_user_meta_data->>'role' = 'admin'
        )
    );

-- 4. PUBLIC READ POLICIES FOR SOME TABLES
-- =============================================================================

-- Subscription plans: Public read access
CREATE POLICY "Public can view subscription plans" ON public.subscriptions
    FOR SELECT USING (true);

-- 5. FIX SECURITY DEFINER VIEWS (Convert to SECURITY INVOKER)
-- =============================================================================

-- Note: These views need to be recreated without SECURITY DEFINER
-- This is a template - you'll need to get the actual view definitions first

-- DROP VIEW public.crash_summary;
-- CREATE VIEW public.crash_summary AS 
-- [Your view definition here]
-- SECURITY INVOKER;

-- Repeat for all SECURITY DEFINER views:
-- - friend_requests_view
-- - v_active_announcements  
-- - conversation_analytics_view
-- - referral_dashboard
-- - ai_conversation_analytics
-- - daily_active_users
-- - app_version_distribution
-- - call_analytics
-- - real_time_metrics_view
-- - feature_adoption
-- - accepted_friendships_view

-- =============================================================================
-- VERIFICATION QUERIES
-- =============================================================================

-- Check RLS is enabled on all tables
SELECT schemaname, tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND rowsecurity = false;

-- Check for remaining SECURITY DEFINER views
SELECT schemaname, viewname, definition
FROM pg_views 
WHERE schemaname = 'public' 
AND definition ILIKE '%SECURITY DEFINER%';

-- Count policies per table
SELECT schemaname, tablename, 
       (SELECT count(*) FROM pg_policies WHERE tablename = t.tablename) as policy_count
FROM pg_tables t
WHERE schemaname = 'public'
ORDER BY policy_count;
