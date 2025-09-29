-- Migration to ensure usernames are unique case-insensitively while preserving original case
-- This allows storing "JohnDoe" but prevents "johndoe" from being registered

-- Drop existing username index if it exists
DROP INDEX IF EXISTS idx_profiles_username;

-- Create case-insensitive unique index on username
CREATE UNIQUE INDEX idx_profiles_username_unique_ci ON profiles (LOWER(username));

-- Add regular index for fast lookups (case-sensitive)
CREATE INDEX idx_profiles_username ON profiles (username);

-- Update any existing duplicate usernames (if any exist)
-- This query will find duplicates and append numbers to make them unique
WITH duplicates AS (
  SELECT 
    id,
    username,
    ROW_NUMBER() OVER (PARTITION BY LOWER(username) ORDER BY created_at) as rn
  FROM profiles
  WHERE username IS NOT NULL
),
updates AS (
  SELECT 
    id,
    CASE 
      WHEN rn = 1 THEN username
      ELSE username || '_' || rn
    END as new_username
  FROM duplicates
  WHERE rn > 1
)
UPDATE profiles 
SET username = updates.new_username
FROM updates
WHERE profiles.id = updates.id;

-- Add comment to document the change
COMMENT ON INDEX idx_profiles_username_unique_ci IS 'Ensures usernames are unique case-insensitively while preserving original case in storage';
