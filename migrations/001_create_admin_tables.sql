-- Circle App Admin Panel Database Migration
-- Created: 2025-10-05
-- Description: Creates tables for admin panel functionality

-- ============================================
-- Admin Roles and Permissions
-- ============================================

-- Admin roles table
CREATE TABLE IF NOT EXISTS admin_roles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'moderator', 'support')),
  granted_by UUID REFERENCES profiles(id),
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT true,
  UNIQUE(user_id)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_admin_roles_user_id ON admin_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_roles_role ON admin_roles(role);
CREATE INDEX IF NOT EXISTS idx_admin_roles_active ON admin_roles(is_active);

-- ============================================
-- Admin Audit Logs
-- ============================================

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID REFERENCES profiles(id),
  action TEXT NOT NULL,
  target_type TEXT, -- 'user', 'message', 'report', 'campaign', etc.
  target_id UUID,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for audit logs
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_id ON admin_audit_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON admin_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target_type ON admin_audit_logs(target_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON admin_audit_logs(created_at DESC);

-- ============================================
-- User Reports
-- ============================================

CREATE TABLE IF NOT EXISTS user_reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID REFERENCES profiles(id),
  reported_user_id UUID REFERENCES profiles(id),
  report_type TEXT NOT NULL CHECK (report_type IN ('harassment', 'spam', 'inappropriate_content', 'fake_profile', 'underage', 'other')),
  reason TEXT,
  evidence JSONB, -- screenshots, message IDs, etc.
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewing', 'resolved', 'dismissed')),
  moderator_id UUID REFERENCES profiles(id),
  moderator_notes TEXT,
  action_taken TEXT, -- 'warning', 'suspension', 'ban', 'content_removed', 'no_action'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Create indexes for reports
CREATE INDEX IF NOT EXISTS idx_reports_reporter_id ON user_reports(reporter_id);
CREATE INDEX IF NOT EXISTS idx_reports_reported_user_id ON user_reports(reported_user_id);
CREATE INDEX IF NOT EXISTS idx_reports_status ON user_reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_type ON user_reports(report_type);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON user_reports(created_at DESC);

-- ============================================
-- System Settings
-- ============================================

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  description TEXT,
  category TEXT, -- 'general', 'security', 'features', 'limits'
  updated_by UUID REFERENCES profiles(id),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for category
CREATE INDEX IF NOT EXISTS idx_system_settings_category ON system_settings(category);

-- ============================================
-- Feature Flags
-- ============================================

CREATE TABLE IF NOT EXISTS feature_flags (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT UNIQUE NOT NULL,
  enabled BOOLEAN DEFAULT false,
  description TEXT,
  rollout_percentage INTEGER DEFAULT 100 CHECK (rollout_percentage >= 0 AND rollout_percentage <= 100),
  target_users JSONB, -- Array of user IDs for targeted rollout
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for feature flags
CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled ON feature_flags(enabled);
CREATE INDEX IF NOT EXISTS idx_feature_flags_name ON feature_flags(name);

-- ============================================
-- Marketing Campaigns
-- ============================================

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('push_notification', 'email', 'in_app')),
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'sent', 'paused', 'cancelled')),
  subject TEXT,
  content TEXT NOT NULL,
  template_id UUID,
  segment_criteria JSONB, -- User segmentation rules
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for campaigns
CREATE INDEX IF NOT EXISTS idx_campaigns_type ON marketing_campaigns(type);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON marketing_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON marketing_campaigns(created_by);
CREATE INDEX IF NOT EXISTS idx_campaigns_scheduled_at ON marketing_campaigns(scheduled_at);

-- ============================================
-- Campaign Analytics
-- ============================================

CREATE TABLE IF NOT EXISTS campaign_analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE CASCADE UNIQUE,
  total_sent INTEGER DEFAULT 0,
  delivered INTEGER DEFAULT 0,
  opened INTEGER DEFAULT 0,
  clicked INTEGER DEFAULT 0,
  converted INTEGER DEFAULT 0,
  unsubscribed INTEGER DEFAULT 0,
  bounced INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for campaign analytics
CREATE INDEX IF NOT EXISTS idx_campaign_analytics_campaign_id ON campaign_analytics(campaign_id);

-- ============================================
-- User Campaign Interactions
-- ============================================

CREATE TABLE IF NOT EXISTS user_campaign_interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('sent', 'delivered', 'opened', 'clicked', 'converted', 'unsubscribed', 'bounced')),
  metadata JSONB, -- Click data, device info, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for interactions
CREATE INDEX IF NOT EXISTS idx_interactions_campaign_id ON user_campaign_interactions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_interactions_user_id ON user_campaign_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_interactions_action ON user_campaign_interactions(action);
CREATE UNIQUE INDEX IF NOT EXISTS idx_interactions_unique ON user_campaign_interactions(campaign_id, user_id, action);

-- ============================================
-- Email Templates
-- ============================================

CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT,
  category TEXT CHECK (category IN ('welcome', 'engagement', 're-engagement', 'promotional', 'transactional')),
  variables JSONB, -- Available variables for personalization
  preview_text TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for email templates
CREATE INDEX IF NOT EXISTS idx_email_templates_category ON email_templates(category);
CREATE INDEX IF NOT EXISTS idx_email_templates_created_by ON email_templates(created_by);

-- ============================================
-- Push Notification Templates
-- ============================================

CREATE TABLE IF NOT EXISTS notification_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT CHECK (category IN ('match', 'message', 'engagement', 're-engagement', 'system')),
  icon TEXT,
  image_url TEXT,
  deep_link TEXT,
  variables JSONB, -- Available variables for personalization
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for notification templates
CREATE INDEX IF NOT EXISTS idx_notification_templates_category ON notification_templates(category);
CREATE INDEX IF NOT EXISTS idx_notification_templates_created_by ON notification_templates(created_by);

-- ============================================
-- User Marketing Preferences
-- ============================================

CREATE TABLE IF NOT EXISTS user_marketing_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  email_enabled BOOLEAN DEFAULT true,
  push_enabled BOOLEAN DEFAULT true,
  sms_enabled BOOLEAN DEFAULT false,
  frequency_preference TEXT DEFAULT 'normal' CHECK (frequency_preference IN ('high', 'normal', 'low')),
  unsubscribed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for user marketing preferences
CREATE INDEX IF NOT EXISTS idx_marketing_prefs_user_id ON user_marketing_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_marketing_prefs_email_enabled ON user_marketing_preferences(email_enabled);
CREATE INDEX IF NOT EXISTS idx_marketing_prefs_push_enabled ON user_marketing_preferences(push_enabled);

-- ============================================
-- Marketing Automation Rules
-- ============================================

CREATE TABLE IF NOT EXISTS marketing_automation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- user_signup, inactive_7days, no_matches, etc.
  trigger_conditions JSONB,
  action_type TEXT NOT NULL CHECK (action_type IN ('send_email', 'send_push', 'add_to_segment', 'create_notification')),
  action_config JSONB, -- Campaign ID, template ID, etc.
  enabled BOOLEAN DEFAULT true,
  delay_minutes INTEGER DEFAULT 0,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for automation rules
CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger_type ON marketing_automation_rules(trigger_type);
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled ON marketing_automation_rules(enabled);

-- ============================================
-- User Segments
-- ============================================

CREATE TABLE IF NOT EXISTS user_segments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  criteria JSONB NOT NULL, -- Segmentation rules
  user_count INTEGER DEFAULT 0,
  last_calculated_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for user segments
CREATE INDEX IF NOT EXISTS idx_user_segments_created_by ON user_segments(created_by);
CREATE INDEX IF NOT EXISTS idx_user_segments_last_calculated ON user_segments(last_calculated_at);

-- ============================================
-- Insert Default System Settings
-- ============================================

INSERT INTO system_settings (key, value, description, category) VALUES
  ('maintenance_mode', '{"enabled": false}', 'Enable/disable maintenance mode', 'general'),
  ('max_upload_size_mb', '{"value": 10}', 'Maximum file upload size in MB', 'limits'),
  ('session_timeout_minutes', '{"value": 30}', 'Admin session timeout in minutes', 'security'),
  ('rate_limit_per_minute', '{"value": 60}', 'API rate limit per minute', 'limits'),
  ('require_email_verification', '{"enabled": true}', 'Require email verification for new users', 'security')
ON CONFLICT (key) DO NOTHING;

-- ============================================
-- Insert Default Feature Flags
-- ============================================

INSERT INTO feature_flags (name, enabled, description, rollout_percentage) VALUES
  ('voice_calls', true, 'Enable voice calling feature', 100),
  ('location_matching', true, 'Enable location-based matching', 100),
  ('message_requests', true, 'Enable message requests feature', 100),
  ('browser_notifications', true, 'Enable browser push notifications', 100),
  ('background_location', false, 'Enable background location tracking', 0)
ON CONFLICT (name) DO NOTHING;

-- ============================================
-- Grant Permissions (if using RLS)
-- ============================================

-- Enable Row Level Security on admin tables
ALTER TABLE admin_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;

-- Create policies for admin access
-- Note: These are basic policies. Adjust based on your security requirements.

-- Admin roles: Only super admins can manage roles
CREATE POLICY admin_roles_policy ON admin_roles
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles ar
      WHERE ar.user_id = auth.uid()
      AND ar.role = 'super_admin'
      AND ar.is_active = true
    )
  );

-- Audit logs: Admins can view, system can insert
CREATE POLICY admin_audit_logs_select_policy ON admin_audit_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles ar
      WHERE ar.user_id = auth.uid()
      AND ar.is_active = true
    )
  );

CREATE POLICY admin_audit_logs_insert_policy ON admin_audit_logs
  FOR INSERT
  WITH CHECK (true); -- System can always insert

-- User reports: Users can create, admins can manage
CREATE POLICY user_reports_insert_policy ON user_reports
  FOR INSERT
  WITH CHECK (auth.uid() = reporter_id);

CREATE POLICY user_reports_select_policy ON user_reports
  FOR SELECT
  USING (
    auth.uid() = reporter_id OR
    EXISTS (
      SELECT 1 FROM admin_roles ar
      WHERE ar.user_id = auth.uid()
      AND ar.is_active = true
    )
  );

CREATE POLICY user_reports_update_policy ON user_reports
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles ar
      WHERE ar.user_id = auth.uid()
      AND ar.is_active = true
    )
  );

-- System settings: Only super admins can modify
CREATE POLICY system_settings_policy ON system_settings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles ar
      WHERE ar.user_id = auth.uid()
      AND ar.role = 'super_admin'
      AND ar.is_active = true
    )
  );

-- Feature flags: Only super admins can modify
CREATE POLICY feature_flags_policy ON feature_flags
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles ar
      WHERE ar.user_id = auth.uid()
      AND ar.role = 'super_admin'
      AND ar.is_active = true
    )
  );

-- ============================================
-- Migration Complete
-- ============================================

-- Log migration completion
DO $$
BEGIN
  RAISE NOTICE 'Admin panel tables created successfully';
  RAISE NOTICE 'Tables created: admin_roles, admin_audit_logs, user_reports, system_settings, feature_flags';
  RAISE NOTICE 'Marketing tables: marketing_campaigns, campaign_analytics, user_campaign_interactions';
  RAISE NOTICE 'Template tables: email_templates, notification_templates';
  RAISE NOTICE 'Preference tables: user_marketing_preferences, marketing_automation_rules, user_segments';
END $$;
