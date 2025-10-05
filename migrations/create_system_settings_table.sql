-- Create system settings table for admin panel configuration
CREATE TABLE IF NOT EXISTS system_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- App Configuration
  maintenance_mode BOOLEAN DEFAULT FALSE,
  registration_enabled BOOLEAN DEFAULT TRUE,
  matchmaking_enabled BOOLEAN DEFAULT TRUE,
  chat_enabled BOOLEAN DEFAULT TRUE,
  
  -- Limits & Quotas
  max_file_size INTEGER DEFAULT 10, -- MB
  max_messages_per_day INTEGER DEFAULT 1000,
  max_friends_per_user INTEGER DEFAULT 500,
  
  -- Security Settings
  session_timeout INTEGER DEFAULT 30, -- minutes
  max_login_attempts INTEGER DEFAULT 5,
  require_email_verification BOOLEAN DEFAULT TRUE,
  
  -- Content Moderation
  auto_moderation BOOLEAN DEFAULT TRUE,
  profanity_filter BOOLEAN DEFAULT TRUE,
  image_moderation BOOLEAN DEFAULT TRUE,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by UUID REFERENCES profiles(id)
);

-- Create admin logs table for tracking admin actions
CREATE TABLE IF NOT EXISTS admin_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_id UUID NOT NULL REFERENCES profiles(id),
  action TEXT NOT NULL,
  target_type TEXT, -- 'user', 'system', 'content', etc.
  target_id UUID, -- ID of the affected resource
  details JSONB DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_action ON admin_logs(action);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON admin_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_target ON admin_logs(target_type, target_id);

-- Enable Row Level Security
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_logs ENABLE ROW LEVEL SECURITY;

-- Create policies for system settings (admin only)
CREATE POLICY system_settings_admin_policy ON system_settings
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles 
      WHERE user_id = auth.uid()
    )
  );

-- Create policies for admin logs (admin only)
CREATE POLICY admin_logs_admin_policy ON admin_logs
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM admin_roles 
      WHERE user_id = auth.uid()
    )
  );

-- Insert default settings
INSERT INTO system_settings (
  maintenance_mode,
  registration_enabled,
  matchmaking_enabled,
  chat_enabled,
  max_file_size,
  max_messages_per_day,
  max_friends_per_user,
  session_timeout,
  max_login_attempts,
  require_email_verification,
  auto_moderation,
  profanity_filter,
  image_moderation
) VALUES (
  FALSE, -- maintenance_mode
  TRUE,  -- registration_enabled
  TRUE,  -- matchmaking_enabled
  TRUE,  -- chat_enabled
  10,    -- max_file_size (MB)
  1000,  -- max_messages_per_day
  500,   -- max_friends_per_user
  30,    -- session_timeout (minutes)
  5,     -- max_login_attempts
  TRUE,  -- require_email_verification
  TRUE,  -- auto_moderation
  TRUE,  -- profanity_filter
  TRUE   -- image_moderation
) ON CONFLICT DO NOTHING;

-- Create function to update settings timestamp
CREATE OR REPLACE FUNCTION update_settings_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update timestamp
CREATE TRIGGER update_system_settings_timestamp
  BEFORE UPDATE ON system_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_settings_timestamp();

-- Create function to get current system settings
CREATE OR REPLACE FUNCTION get_system_setting(setting_name TEXT)
RETURNS TEXT AS $$
DECLARE
  setting_value TEXT;
BEGIN
  EXECUTE format('SELECT %I::TEXT FROM system_settings LIMIT 1', setting_name)
  INTO setting_value;
  
  RETURN setting_value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to check if feature is enabled
CREATE OR REPLACE FUNCTION is_feature_enabled(feature_name TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  is_enabled BOOLEAN;
BEGIN
  CASE feature_name
    WHEN 'registration' THEN
      SELECT registration_enabled INTO is_enabled FROM system_settings LIMIT 1;
    WHEN 'matchmaking' THEN
      SELECT matchmaking_enabled INTO is_enabled FROM system_settings LIMIT 1;
    WHEN 'chat' THEN
      SELECT chat_enabled INTO is_enabled FROM system_settings LIMIT 1;
    WHEN 'maintenance' THEN
      SELECT maintenance_mode INTO is_enabled FROM system_settings LIMIT 1;
    ELSE
      is_enabled := TRUE; -- Default to enabled for unknown features
  END CASE;
  
  RETURN COALESCE(is_enabled, TRUE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions
GRANT SELECT ON system_settings TO authenticated;
GRANT ALL ON system_settings TO service_role;
GRANT ALL ON admin_logs TO service_role;

-- Add comments for documentation
COMMENT ON TABLE system_settings IS 'System-wide configuration settings managed by administrators';
COMMENT ON TABLE admin_logs IS 'Audit log of all administrative actions performed in the system';

COMMENT ON COLUMN system_settings.maintenance_mode IS 'When true, the app is in maintenance mode and users cannot access it';
COMMENT ON COLUMN system_settings.registration_enabled IS 'When false, new user registration is disabled';
COMMENT ON COLUMN system_settings.matchmaking_enabled IS 'When false, matchmaking system is disabled';
COMMENT ON COLUMN system_settings.chat_enabled IS 'When false, chat functionality is disabled';
COMMENT ON COLUMN system_settings.max_file_size IS 'Maximum file upload size in megabytes';
COMMENT ON COLUMN system_settings.max_messages_per_day IS 'Maximum number of messages a user can send per day';
COMMENT ON COLUMN system_settings.max_friends_per_user IS 'Maximum number of friends a user can have';
COMMENT ON COLUMN system_settings.session_timeout IS 'Session timeout in minutes';
COMMENT ON COLUMN system_settings.max_login_attempts IS 'Maximum failed login attempts before account lockout';
COMMENT ON COLUMN system_settings.require_email_verification IS 'When true, users must verify their email before using the app';
COMMENT ON COLUMN system_settings.auto_moderation IS 'When true, automatic content moderation is enabled';
COMMENT ON COLUMN system_settings.profanity_filter IS 'When true, profanity filtering is enabled';
COMMENT ON COLUMN system_settings.image_moderation IS 'When true, AI-powered image moderation is enabled';
