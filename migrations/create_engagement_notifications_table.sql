-- Engagement notifications tracking (friend-liked-a-meme, meme discovery,
-- birthday, weather check-in). One unified table rather than four: every
-- feature's "don't send this twice" / rate-limit need reduces to the same
-- shape (who got notified, about what, when), so a single
-- UNIQUE(recipient_id, notification_type, dedupe_key) constraint plus an
-- INSERT ... ON CONFLICT DO NOTHING gives every feature atomic,
-- race-free spam prevention for free -- mirrors the existing meme_likes
-- UNIQUE(meme_id, user_id) idempotency pattern.
--
-- dedupe_key meaning is per notification_type:
--   meme_liked_by_friend -> 'YYYY-MM-DD:N'          (N = 1..3, max 3 distinct-meme notifications/day/recipient)
--   meme_discovery       -> 'YYYY-MM-DD:slotN'      (N = 0..7, one of 8 three-hour slots/day; each user is
--                                                    deterministically assigned 4-8 of those slots, see
--                                                    activeDiscoverySlotsForUser() in engagementNotifications.service.ts)
--   birthday_self        -> year, e.g. '2026'         (max 1/year/recipient)
--   friend_birthday      -> '{birthdayUserId}:{year}' (max 1/year per birthday-person/recipient pair)
--   weather_checkin      -> '{targetUserId}:YYYY-MM-DD' (max 1/day per target-person/recipient pair, any condition)
CREATE TABLE IF NOT EXISTS engagement_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    notification_type VARCHAR(40) NOT NULL CHECK (notification_type IN (
        'meme_liked_by_friend', 'meme_discovery', 'birthday_self', 'friend_birthday', 'weather_checkin'
    )),
    dedupe_key VARCHAR(120) NOT NULL,
    related_user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
    related_meme_id UUID REFERENCES memes(id) ON DELETE CASCADE,
    sent_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (recipient_id, notification_type, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_engagement_notifications_recipient_type
    ON engagement_notifications (recipient_id, notification_type, sent_at);

-- Old rows are only ever useful for the dedupe window they were written
-- for (at most a year, for birthdays); nothing reads history beyond that.
CREATE INDEX IF NOT EXISTS idx_engagement_notifications_sent_at
    ON engagement_notifications (sent_at);
