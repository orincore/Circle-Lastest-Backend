-- Migration to create linked social accounts table
-- This allows users to link their Spotify and Instagram accounts with OAuth verification

CREATE TABLE IF NOT EXISTS linked_social_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL CHECK (platform IN ('spotify', 'instagram')),
    platform_user_id VARCHAR(255) NOT NULL, -- The user's ID on the external platform
    platform_username VARCHAR(255), -- The user's username/handle on the platform
    platform_display_name VARCHAR(255), -- The user's display name on the platform
    platform_profile_url VARCHAR(500), -- URL to their profile on the platform
    platform_avatar_url VARCHAR(500), -- URL to their profile picture
    access_token TEXT, -- OAuth access token (encrypted in production)
    refresh_token TEXT, -- OAuth refresh token (encrypted in production)
    token_expires_at TIMESTAMP, -- When the access token expires
    platform_data JSONB, -- Additional platform-specific data
    is_verified BOOLEAN DEFAULT true, -- Whether the account is verified
    is_public BOOLEAN DEFAULT true, -- Whether to show this account on profile
    linked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Ensure one account per platform per user
    UNIQUE(user_id, platform),
    -- Ensure unique platform accounts (one Circle user per external account)
    UNIQUE(platform, platform_user_id)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_linked_social_accounts_user_id ON linked_social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_linked_social_accounts_platform ON linked_social_accounts(platform);
CREATE INDEX IF NOT EXISTS idx_linked_social_accounts_public ON linked_social_accounts(is_public) WHERE is_public = true;
CREATE INDEX IF NOT EXISTS idx_linked_social_accounts_verified ON linked_social_accounts(is_verified) WHERE is_verified = true;

-- Add comments for documentation
COMMENT ON TABLE linked_social_accounts IS 'Stores linked social media accounts (Spotify, Instagram) with OAuth verification';
COMMENT ON COLUMN linked_social_accounts.platform IS 'Social media platform: spotify or instagram';
COMMENT ON COLUMN linked_social_accounts.platform_user_id IS 'User ID on the external platform';
COMMENT ON COLUMN linked_social_accounts.platform_username IS 'Username/handle on the platform';
COMMENT ON COLUMN linked_social_accounts.platform_display_name IS 'Display name on the platform';
COMMENT ON COLUMN linked_social_accounts.access_token IS 'OAuth access token (should be encrypted in production)';
COMMENT ON COLUMN linked_social_accounts.refresh_token IS 'OAuth refresh token (should be encrypted in production)';
COMMENT ON COLUMN linked_social_accounts.is_verified IS 'Whether the account ownership is verified';
COMMENT ON COLUMN linked_social_accounts.is_public IS 'Whether to display this account on user profile';
COMMENT ON COLUMN linked_social_accounts.platform_data IS 'Additional platform-specific data (followers, playlists, etc.)';

-- Create function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_linked_social_accounts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER trigger_update_linked_social_accounts_updated_at
    BEFORE UPDATE ON linked_social_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_linked_social_accounts_updated_at();

-- Sample data structure for platform_data:
-- Spotify: { "followers": 123, "playlists": 45, "top_artists": [...], "recently_played": [...] }
-- Instagram: { "followers": 456, "following": 789, "posts": 123, "bio": "...", "is_verified": false }
