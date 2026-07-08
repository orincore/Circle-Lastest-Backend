-- Migration: Create app_version_config table for forced app updates
-- Run this migration in Supabase SQL Editor

-- Create the app_version_config table
CREATE TABLE IF NOT EXISTS app_version_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    platform VARCHAR(20) NOT NULL UNIQUE CHECK (platform IN ('android', 'ios')),
    min_version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    latest_version VARCHAR(20) NOT NULL DEFAULT '1.0.0',
    force_update BOOLEAN NOT NULL DEFAULT false,
    update_message TEXT DEFAULT 'A new version of Circle is available. Please update to continue.',
    optional_update_message TEXT DEFAULT 'A new version is available with new features!',
    store_url TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    updated_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_app_version_config_platform ON app_version_config(platform);

-- Enable RLS
ALTER TABLE app_version_config ENABLE ROW LEVEL SECURITY;

-- Policy: Allow public read access (for version check endpoint)
CREATE POLICY "Allow public read access to app version config"
    ON app_version_config
    FOR SELECT
    TO public
    USING (true);

-- Policy: Only admins can update
CREATE POLICY "Only admins can update app version config"
    ON app_version_config
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.is_admin = true
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.is_admin = true
        )
    );

-- Insert default configs for Android and iOS
INSERT INTO app_version_config (platform, min_version, latest_version, force_update, store_url)
VALUES 
    ('android', '1.0.0', '1.3.1', false, 'https://play.google.com/store/apps/details?id=com.orincore.Circle'),
    ('ios', '1.0.0', '1.3.1', false, 'https://apps.apple.com/app/circle/id000000000')
ON CONFLICT (platform) DO NOTHING;

-- Add comment to table
COMMENT ON TABLE app_version_config IS 'Configuration for forced app updates. Admins can set minimum required version to force users to update.';
COMMENT ON COLUMN app_version_config.min_version IS 'Minimum version required. Users below this version will be prompted/forced to update.';
COMMENT ON COLUMN app_version_config.latest_version IS 'Latest available version in the store.';
COMMENT ON COLUMN app_version_config.force_update IS 'If true, users cannot skip the update prompt when below min_version.';
