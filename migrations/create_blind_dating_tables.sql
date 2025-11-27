-- Blind Dating / Anonymous Matchmaking Feature
-- This migration creates all tables needed for the blind dating feature

-- Table for user blind dating settings
CREATE TABLE IF NOT EXISTS blind_dating_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    is_enabled BOOLEAN DEFAULT false,
    daily_match_time TIME DEFAULT '09:00:00', -- Default morning time for matches
    max_active_matches INTEGER DEFAULT 3, -- Max concurrent blind dates
    preferred_reveal_threshold INTEGER DEFAULT 30, -- Messages before reveal option
    auto_match BOOLEAN DEFAULT true, -- Automatically find matches
    notifications_enabled BOOLEAN DEFAULT true,
    last_match_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id)
);

-- Table for blind date matches (pairs)
CREATE TABLE IF NOT EXISTS blind_date_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_a UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    user_b UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    compatibility_score DECIMAL(5,2), -- Stored compatibility percentage
    status VARCHAR(20) DEFAULT 'active' CHECK (status IN ('active', 'revealed', 'ended', 'expired', 'blocked')),
    message_count INTEGER DEFAULT 0,
    reveal_threshold INTEGER DEFAULT 30, -- Messages needed to unlock reveal
    
    -- Reveal status for each user
    user_a_revealed BOOLEAN DEFAULT false,
    user_b_revealed BOOLEAN DEFAULT false,
    revealed_at TIMESTAMP WITH TIME ZONE,
    
    -- Who initiated the reveal request
    reveal_requested_by UUID REFERENCES profiles(id),
    reveal_requested_at TIMESTAMP WITH TIME ZONE,
    
    -- Match metadata
    matched_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    ended_by UUID REFERENCES profiles(id),
    end_reason VARCHAR(50),
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    
    CONSTRAINT unique_blind_date_pair CHECK (user_a < user_b),
    UNIQUE(user_a, user_b, status)
);

-- Table for blocked/filtered messages (when personal info detected)
CREATE TABLE IF NOT EXISTS blind_date_blocked_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blind_date_id UUID NOT NULL REFERENCES blind_date_matches(id) ON DELETE CASCADE,
    sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    original_message TEXT NOT NULL,
    filtered_message TEXT, -- Message with personal info redacted (optional)
    blocked_reason TEXT, -- What personal info was detected
    detection_confidence DECIMAL(3,2), -- AI confidence score (0-1)
    ai_analysis JSONB, -- Full AI analysis response
    was_released BOOLEAN DEFAULT false, -- If message was later released after reveal
    released_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Table for tracking daily matches (for the morning match job)
CREATE TABLE IF NOT EXISTS blind_date_daily_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    scheduled_date DATE NOT NULL,
    matched_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    match_id UUID REFERENCES blind_date_matches(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'matched', 'no_match', 'skipped', 'error')),
    processed_at TIMESTAMP WITH TIME ZONE,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, scheduled_date)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_blind_dating_settings_user ON blind_dating_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_blind_dating_settings_enabled ON blind_dating_settings(is_enabled) WHERE is_enabled = true;
CREATE INDEX IF NOT EXISTS idx_blind_date_matches_users ON blind_date_matches(user_a, user_b);
CREATE INDEX IF NOT EXISTS idx_blind_date_matches_status ON blind_date_matches(status);
CREATE INDEX IF NOT EXISTS idx_blind_date_matches_chat ON blind_date_matches(chat_id);
CREATE INDEX IF NOT EXISTS idx_blind_date_blocked_messages ON blind_date_blocked_messages(blind_date_id);
CREATE INDEX IF NOT EXISTS idx_blind_date_daily_queue_date ON blind_date_daily_queue(scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_blind_date_daily_queue_user ON blind_date_daily_queue(user_id);

-- Function to update message count and check reveal eligibility
CREATE OR REPLACE FUNCTION update_blind_date_message_count()
RETURNS TRIGGER AS $$
DECLARE
    blind_date_record blind_date_matches%ROWTYPE;
BEGIN
    -- Find the blind date match for this chat
    SELECT * INTO blind_date_record
    FROM blind_date_matches
    WHERE chat_id = NEW.chat_id AND status = 'active'
    LIMIT 1;
    
    IF blind_date_record.id IS NOT NULL THEN
        -- Increment message count
        UPDATE blind_date_matches
        SET message_count = message_count + 1,
            updated_at = NOW()
        WHERE id = blind_date_record.id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update message count when new messages are sent
DROP TRIGGER IF EXISTS trigger_blind_date_message_count ON messages;
CREATE TRIGGER trigger_blind_date_message_count
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION update_blind_date_message_count();

-- Function to find eligible users for blind dating
CREATE OR REPLACE FUNCTION find_blind_dating_eligible_users(
    exclude_user_id UUID,
    max_results INTEGER DEFAULT 100
)
RETURNS TABLE (
    user_id UUID,
    compatibility_data JSONB
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        jsonb_build_object(
            'age', p.age,
            'gender', p.gender,
            'interests', p.interests,
            'needs', p.needs,
            'location_city', p.location_city,
            'location_country', p.location_country
        ) as compatibility_data
    FROM profiles p
    INNER JOIN blind_dating_settings bds ON bds.user_id = p.id
    WHERE 
        p.id != exclude_user_id
        AND bds.is_enabled = true
        AND p.deleted_at IS NULL
        AND (p.is_suspended IS NULL OR p.is_suspended = false)
        AND (p.invisible_mode IS NULL OR p.invisible_mode = false)
        -- Exclude users already in active blind dates with this user
        AND p.id NOT IN (
            SELECT CASE 
                WHEN bdm.user_a = exclude_user_id THEN bdm.user_b 
                ELSE bdm.user_a 
            END
            FROM blind_date_matches bdm
            WHERE (bdm.user_a = exclude_user_id OR bdm.user_b = exclude_user_id)
            AND bdm.status IN ('active', 'revealed')
        )
        -- Check max active matches limit
        AND (
            SELECT COUNT(*) 
            FROM blind_date_matches bdm2
            WHERE (bdm2.user_a = p.id OR bdm2.user_b = p.id)
            AND bdm2.status IN ('active', 'revealed')
        ) < COALESCE(bds.max_active_matches, 3)
    ORDER BY bds.last_match_at ASC NULLS FIRST -- Prioritize users who haven't matched recently
    LIMIT max_results;
END;
$$ LANGUAGE plpgsql;

-- Function to anonymize user data for blind dating
CREATE OR REPLACE FUNCTION get_anonymized_user_profile(
    target_user_id UUID,
    is_revealed BOOLEAN DEFAULT false
)
RETURNS JSONB AS $$
DECLARE
    user_profile profiles%ROWTYPE;
    anonymized_name TEXT;
    result JSONB;
BEGIN
    SELECT * INTO user_profile FROM profiles WHERE id = target_user_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    IF is_revealed THEN
        -- Return full profile
        result := jsonb_build_object(
            'id', user_profile.id,
            'first_name', user_profile.first_name,
            'last_name', user_profile.last_name,
            'username', user_profile.username,
            'age', user_profile.age,
            'gender', user_profile.gender,
            'about', user_profile.about,
            'interests', user_profile.interests,
            'needs', user_profile.needs,
            'profile_photo_url', user_profile.profile_photo_url,
            'location_city', user_profile.location_city,
            'is_revealed', true
        );
    ELSE
        -- Return anonymized profile
        -- Create starred versions of names
        anonymized_name := CASE 
            WHEN length(user_profile.first_name) > 0 
            THEN substring(user_profile.first_name, 1, 1) || repeat('*', greatest(length(user_profile.first_name) - 1, 2))
            ELSE '***'
        END;
        
        result := jsonb_build_object(
            'id', user_profile.id,
            'first_name', anonymized_name,
            'last_name', '***',
            'username', '***hidden***',
            'age', user_profile.age,
            'gender', user_profile.gender,
            'about', NULL, -- Hidden in anonymous mode
            'interests', user_profile.interests,
            'needs', user_profile.needs,
            'profile_photo_url', NULL, -- Hidden in anonymous mode
            'location_city', CASE 
                WHEN user_profile.location_city IS NOT NULL 
                THEN substring(user_profile.location_city, 1, 1) || '****'
                ELSE NULL 
            END,
            'is_revealed', false,
            'anonymous_avatar', 'https://api.dicebear.com/7.x/shapes/svg?seed=' || encode(digest(target_user_id::text, 'sha256'), 'hex')
        );
    END IF;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Grant permissions (adjust as needed for your setup)
-- GRANT SELECT, INSERT, UPDATE, DELETE ON blind_dating_settings TO authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON blind_date_matches TO authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON blind_date_blocked_messages TO authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON blind_date_daily_queue TO authenticated;

COMMENT ON TABLE blind_dating_settings IS 'User settings for anonymous/blind dating feature';
COMMENT ON TABLE blind_date_matches IS 'Active and historical blind date pairs';
COMMENT ON TABLE blind_date_blocked_messages IS 'Messages blocked by AI for containing personal information';
COMMENT ON TABLE blind_date_daily_queue IS 'Queue for daily morning match scheduling';

