-- Marketing Campaigns System
-- This migration creates all tables needed for push notification campaigns, email marketing, and user segmentation

-- Marketing campaigns table
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

-- Campaign analytics table
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

-- User campaign interactions table
CREATE TABLE IF NOT EXISTS user_campaign_interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID REFERENCES marketing_campaigns(id) ON DELETE CASCADE,
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('sent', 'delivered', 'opened', 'clicked', 'converted', 'unsubscribed', 'bounced')),
  metadata JSONB, -- Click data, device info, etc.
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Push notification templates table
CREATE TABLE IF NOT EXISTS notification_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT, -- match, message, engagement, re-engagement
  icon TEXT,
  image_url TEXT,
  deep_link TEXT,
  variables JSONB, -- Available variables for personalization
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Email templates table
CREATE TABLE IF NOT EXISTS email_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  html_content TEXT NOT NULL,
  text_content TEXT,
  category TEXT, -- welcome, engagement, re-engagement, promotional
  variables JSONB, -- Available variables for personalization
  preview_text TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User segments table
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

-- User marketing preferences table
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

-- Marketing automation rules table
CREATE TABLE IF NOT EXISTS marketing_automation_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL, -- user_signup, inactive_7days, no_matches, etc.
  trigger_conditions JSONB,
  action_type TEXT NOT NULL, -- send_email, send_push, add_to_segment
  action_config JSONB, -- Campaign ID, template ID, etc.
  enabled BOOLEAN DEFAULT true,
  delay_minutes INTEGER DEFAULT 0, -- Delay before executing action
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON marketing_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_type ON marketing_campaigns(type);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_by ON marketing_campaigns(created_by);
CREATE INDEX IF NOT EXISTS idx_campaign_interactions_campaign ON user_campaign_interactions(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_interactions_user ON user_campaign_interactions(user_id);
CREATE INDEX IF NOT EXISTS idx_segments_created_by ON user_segments(created_by);
CREATE INDEX IF NOT EXISTS idx_marketing_prefs_user ON user_marketing_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_enabled ON marketing_automation_rules(enabled);

-- Add comments
COMMENT ON TABLE marketing_campaigns IS 'Stores all marketing campaigns (push, email, in-app)';
COMMENT ON TABLE campaign_analytics IS 'Aggregated analytics for each campaign';
COMMENT ON TABLE user_campaign_interactions IS 'Individual user interactions with campaigns';
COMMENT ON TABLE notification_templates IS 'Reusable push notification templates';
COMMENT ON TABLE email_templates IS 'Reusable email templates';
COMMENT ON TABLE user_segments IS 'User segmentation definitions';
COMMENT ON TABLE user_marketing_preferences IS 'User preferences for marketing communications';
COMMENT ON TABLE marketing_automation_rules IS 'Automated marketing rules and triggers';

-- Insert default notification templates
INSERT INTO notification_templates (name, title, body, category, icon, deep_link, variables) VALUES
('new_matches', 'New Matches Available! 💕', 'You have {{count}} new potential matches near you. Check them out!', 'match', 'heart', 'circle://match', '{"count": "number"}'),
('profile_liked', 'Someone Liked You! 😍', '{{name}} liked your profile. View their profile now!', 'match', 'heart', 'circle://profile/{{userId}}', '{"name": "string", "userId": "string"}'),
('unread_messages', 'New Messages 💬', 'You have {{count}} unread messages. Don''t keep them waiting!', 'message', 'chatbubbles', 'circle://chat', '{"count": "number"}'),
('complete_profile', 'Complete Your Profile ✨', 'Add more details to your profile to get better matches!', 'engagement', 'person', 'circle://profile/edit', '{}'),
('inactive_reminder', 'We Miss You! 💔', 'Come back to Circle and find your perfect match!', 're-engagement', 'heart-dislike', 'circle://match', '{}'),
('new_users_nearby', 'New Users in {{city}}! 🌟', '{{count}} new users joined Circle in your area. Say hello!', 'engagement', 'location', 'circle://location', '{"city": "string", "count": "number"}'),
('weekend_special', 'Weekend Special 🎉', 'Find your match this weekend! More users are active now.', 'engagement', 'calendar', 'circle://match', '{}')
ON CONFLICT DO NOTHING;

-- Insert default email templates
INSERT INTO email_templates (name, subject, html_content, text_content, category, variables, preview_text) VALUES
('welcome_email', 'Welcome to Circle! 🎉', '<h1>Welcome to Circle, {{firstName}}!</h1><p>We''re excited to have you join our community.</p>', 'Welcome to Circle, {{firstName}}! We''re excited to have you join our community.', 'welcome', '{"firstName": "string"}', 'Welcome to Circle! Let''s get started'),
('inactive_7days', 'We Miss You at Circle 💔', '<h1>Come back, {{firstName}}!</h1><p>We''ve missed you. New matches are waiting for you.</p>', 'Come back, {{firstName}}! We''ve missed you. New matches are waiting for you.', 're-engagement', '{"firstName": "string"}', 'Come back to Circle - New matches await!'),
('weekly_digest', 'Your Weekly Circle Summary 📊', '<h1>Hi {{firstName}}!</h1><p>Here''s what happened this week: {{summary}}</p>', 'Hi {{firstName}}! Here''s what happened this week: {{summary}}', 'engagement', '{"firstName": "string", "summary": "string"}', 'Your weekly activity summary')
ON CONFLICT DO NOTHING;
