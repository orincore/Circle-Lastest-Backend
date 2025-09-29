-- Rollback Migration: Remove soft delete support from linked_social_accounts table
-- WARNING: This will permanently delete all soft-deleted accounts!
-- Make sure to backup data before running this rollback.

-- Drop the helper view
DROP VIEW IF EXISTS active_linked_social_accounts;

-- Remove the constraint
ALTER TABLE linked_social_accounts 
DROP CONSTRAINT IF EXISTS check_deleted_accounts_retain_data;

-- Drop the indexes
DROP INDEX IF EXISTS idx_linked_social_accounts_deleted_at;
DROP INDEX IF EXISTS idx_linked_social_accounts_active_platform;
DROP INDEX IF EXISTS idx_linked_social_accounts_active_username;

-- OPTIONAL: Delete soft-deleted records before removing column
-- Uncomment the next line if you want to permanently delete soft-deleted accounts
-- DELETE FROM linked_social_accounts WHERE deleted_at IS NOT NULL;

-- Remove the deleted_at column
ALTER TABLE linked_social_accounts 
DROP COLUMN IF EXISTS deleted_at;

-- Note: This rollback will permanently lose all soft-deleted account data
-- Consider exporting soft-deleted accounts before running this rollback
