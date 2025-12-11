-- Create nearby_notifications table for tracking notification cooldowns
-- This table persists notification history to prevent duplicate nearby user notifications

CREATE TABLE IF NOT EXISTS nearby_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    to_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_nearby_notifications_from_user ON nearby_notifications(from_user_id);
CREATE INDEX IF NOT EXISTS idx_nearby_notifications_to_user ON nearby_notifications(to_user_id);
CREATE INDEX IF NOT EXISTS idx_nearby_notifications_sent_at ON nearby_notifications(sent_at);
CREATE INDEX IF NOT EXISTS idx_nearby_notifications_user_pair ON nearby_notifications(from_user_id, to_user_id);

-- Add comment explaining the table purpose
COMMENT ON TABLE nearby_notifications IS 'Tracks nearby user notifications with 5-day cooldown to prevent spam';
COMMENT ON COLUMN nearby_notifications.from_user_id IS 'User who triggered the nearby notification';
COMMENT ON COLUMN nearby_notifications.to_user_id IS 'User who received the nearby notification';
COMMENT ON COLUMN nearby_notifications.sent_at IS 'When the notification was sent (used for cooldown calculation)';
