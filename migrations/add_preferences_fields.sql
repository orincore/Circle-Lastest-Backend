-- Add preferences fields to profiles table
-- This migration adds matching preference fields to store user preferences in the database

-- Add preference columns to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS location_preference VARCHAR(50) DEFAULT 'nearby',
ADD COLUMN IF NOT EXISTS age_preference VARCHAR(50) DEFAULT 'flexible',
ADD COLUMN IF NOT EXISTS friendship_location_priority BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS relationship_distance_flexible BOOLEAN DEFAULT true,
ADD COLUMN IF NOT EXISTS preferences_updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Add index on preferences for faster queries
CREATE INDEX IF NOT EXISTS idx_profiles_location_preference ON profiles(location_preference);
CREATE INDEX IF NOT EXISTS idx_profiles_age_preference ON profiles(age_preference);
CREATE INDEX IF NOT EXISTS idx_profiles_friendship_location_priority ON profiles(friendship_location_priority);
CREATE INDEX IF NOT EXISTS idx_profiles_relationship_distance_flexible ON profiles(relationship_distance_flexible);

-- Add comments for documentation
COMMENT ON COLUMN profiles.location_preference IS 'User preference for location matching: local, nearby, city, region, country, international';
COMMENT ON COLUMN profiles.age_preference IS 'User preference for age range matching: close, similar, flexible, open, any';
COMMENT ON COLUMN profiles.friendship_location_priority IS 'Whether to prioritize location for friendship matches';
COMMENT ON COLUMN profiles.relationship_distance_flexible IS 'Whether to allow flexible distance for relationship matches';
COMMENT ON COLUMN profiles.preferences_updated_at IS 'Timestamp when preferences were last updated';

-- Update existing users with default preferences if they don't have them
UPDATE profiles 
SET 
  location_preference = COALESCE(location_preference, 'nearby'),
  age_preference = COALESCE(age_preference, 'flexible'),
  friendship_location_priority = COALESCE(friendship_location_priority, true),
  relationship_distance_flexible = COALESCE(relationship_distance_flexible, true),
  preferences_updated_at = COALESCE(preferences_updated_at, created_at, NOW())
WHERE 
  location_preference IS NULL 
  OR age_preference IS NULL 
  OR friendship_location_priority IS NULL 
  OR relationship_distance_flexible IS NULL 
  OR preferences_updated_at IS NULL;

-- Create a function to automatically update preferences_updated_at
CREATE OR REPLACE FUNCTION update_preferences_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  -- Only update if preference fields have actually changed
  IF (OLD.location_preference IS DISTINCT FROM NEW.location_preference) OR
     (OLD.age_preference IS DISTINCT FROM NEW.age_preference) OR
     (OLD.friendship_location_priority IS DISTINCT FROM NEW.friendship_location_priority) OR
     (OLD.relationship_distance_flexible IS DISTINCT FROM NEW.relationship_distance_flexible) THEN
    NEW.preferences_updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update preferences_updated_at
DROP TRIGGER IF EXISTS trigger_update_preferences_updated_at ON profiles;
CREATE TRIGGER trigger_update_preferences_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_preferences_updated_at();

-- Verify the migration
DO $$
BEGIN
  -- Check if all columns exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'location_preference') THEN
    RAISE EXCEPTION 'Migration failed: location_preference column not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'age_preference') THEN
    RAISE EXCEPTION 'Migration failed: age_preference column not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'friendship_location_priority') THEN
    RAISE EXCEPTION 'Migration failed: friendship_location_priority column not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'relationship_distance_flexible') THEN
    RAISE EXCEPTION 'Migration failed: relationship_distance_flexible column not created';
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'preferences_updated_at') THEN
    RAISE EXCEPTION 'Migration failed: preferences_updated_at column not created';
  END IF;
  
  RAISE NOTICE 'Migration completed successfully: All preference columns added to profiles table';
END $$;
