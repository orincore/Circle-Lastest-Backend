-- Migration: Add soft delete support to linked_social_accounts table
-- This enables soft delete functionality for social account unlinking
-- Users can reactivate accounts by relinking the same username

-- Add deleted_at column for soft delete functionality
ALTER TABLE linked_social_accounts 
ADD COLUMN deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Add index on deleted_at for performance when filtering active accounts
CREATE INDEX idx_linked_social_accounts_deleted_at 
ON linked_social_accounts (deleted_at);

-- Add composite index for efficient active account queries
CREATE INDEX idx_linked_social_accounts_active_platform 
ON linked_social_accounts (user_id, platform, deleted_at) 
WHERE deleted_at IS NULL;

-- Add composite index for username conflict checking (active accounts only)
CREATE INDEX idx_linked_social_accounts_active_username 
ON linked_social_accounts (platform, platform_username, deleted_at) 
WHERE deleted_at IS NULL;

-- Update existing records to ensure they have deleted_at = NULL (active)
UPDATE linked_social_accounts 
SET deleted_at = NULL 
WHERE deleted_at IS NULL;

-- Add comment to document the soft delete functionality
COMMENT ON COLUMN linked_social_accounts.deleted_at IS 
'Timestamp when account was soft deleted. NULL means account is active. Enables reactivation by relinking same username.';

-- Optional: Add constraint to ensure deleted accounts have proper metadata
-- This ensures deleted accounts retain their platform_data for audit trail
ALTER TABLE linked_social_accounts 
ADD CONSTRAINT check_deleted_accounts_retain_data 
CHECK (
  (deleted_at IS NULL) OR 
  (deleted_at IS NOT NULL AND platform_data IS NOT NULL)
);

-- Create view for active accounts only (optional helper view)
CREATE OR REPLACE VIEW active_linked_social_accounts AS
SELECT 
  id,
  user_id,
  platform,
  platform_user_id,
  platform_username,
  platform_display_name,
  platform_profile_url,
  platform_avatar_url,
  access_token,
  refresh_token,
  token_expires_at,
  platform_data,
  is_verified,
  is_public,
  linked_at,
  updated_at
FROM linked_social_accounts
WHERE deleted_at IS NULL;

COMMENT ON VIEW active_linked_social_accounts IS 
'View showing only active (non-deleted) social accounts for easier querying';
