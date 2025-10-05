-- Push Tokens Table
-- Stores user push notification tokens for Expo notifications

CREATE TABLE IF NOT EXISTS push_tokens (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
  token TEXT NOT NULL,
  device_type TEXT CHECK (device_type IN ('ios', 'android', 'web')),
  device_name TEXT,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_push_tokens_user_id ON push_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_push_tokens_enabled ON push_tokens(enabled);
CREATE INDEX IF NOT EXISTS idx_push_tokens_token ON push_tokens(token);

-- Create unique constraint to prevent duplicate tokens
CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_user_token ON push_tokens(user_id, token);

-- Add comment
COMMENT ON TABLE push_tokens IS 'Stores user push notification tokens for Expo push notifications';
COMMENT ON COLUMN push_tokens.token IS 'Expo push token (ExponentPushToken[...])';
COMMENT ON COLUMN push_tokens.enabled IS 'Whether push notifications are enabled for this token';
COMMENT ON COLUMN push_tokens.last_used_at IS 'Last time a notification was sent to this token';
