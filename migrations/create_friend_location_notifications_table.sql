-- Create friend_location_notifications table for tracking friend location notification cooldowns
-- This table persists notification history to prevent duplicate friend location notifications
-- Separate from nearby_notifications which is for unknown users

CREATE TABLE IF NOT EXISTS friend_location_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    to_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    sent_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient lookups
CREATE INDEX IF NOT EXISTS idx_friend_location_notifications_from_user ON friend_location_notifications(from_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_location_notifications_to_user ON friend_location_notifications(to_user_id);
CREATE INDEX IF NOT EXISTS idx_friend_location_notifications_sent_at ON friend_location_notifications(sent_at);
CREATE INDEX IF NOT EXISTS idx_friend_location_notifications_user_pair ON friend_location_notifications(from_user_id, to_user_id);

-- Add comment explaining the table purpose
COMMENT ON TABLE friend_location_notifications IS 'Tracks friend location notifications with 5-day cooldown to prevent spam. Only for mutual friends within 3km.';
COMMENT ON COLUMN friend_location_notifications.from_user_id IS 'User who triggered the location update notification';
COMMENT ON COLUMN friend_location_notifications.to_user_id IS 'Friend who received the location notification';
COMMENT ON COLUMN friend_location_notifications.sent_at IS 'When the notification was sent (used for 5-day cooldown calculation)';
