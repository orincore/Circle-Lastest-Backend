-- Add location fields to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8),
ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8),
ADD COLUMN IF NOT EXISTS location_address TEXT,
ADD COLUMN IF NOT EXISTS location_city TEXT,
ADD COLUMN IF NOT EXISTS location_country TEXT,
ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;

-- Create index for efficient location queries
CREATE INDEX IF NOT EXISTS idx_profiles_location ON profiles (latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_profiles_location_updated ON profiles (location_updated_at);

-- Create a function to find nearby users using Haversine formula
CREATE OR REPLACE FUNCTION find_nearby_users(
  user_lat DECIMAL,
  user_lng DECIMAL,
  radius_km DECIMAL DEFAULT 50,
  exclude_user_id UUID DEFAULT NULL,
  result_limit INTEGER DEFAULT 100
)
RETURNS TABLE (
  id UUID,
  email TEXT,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  age INTEGER,
  gender TEXT,
  phone_number TEXT,
  interests TEXT[],
  needs TEXT[],
  profile_photo_url TEXT,
  password_hash TEXT,
  latitude DECIMAL,
  longitude DECIMAL,
  location_address TEXT,
  location_city TEXT,
  location_country TEXT,
  location_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  distance DECIMAL
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    p.*,
    (
      6371 * acos(
        cos(radians(user_lat)) * 
        cos(radians(p.latitude)) * 
        cos(radians(p.longitude) - radians(user_lng)) + 
        sin(radians(user_lat)) * 
        sin(radians(p.latitude))
      )
    )::DECIMAL AS distance
  FROM profiles p
  WHERE 
    p.latitude IS NOT NULL 
    AND p.longitude IS NOT NULL
    AND (exclude_user_id IS NULL OR p.id != exclude_user_id)
    AND (
      6371 * acos(
        cos(radians(user_lat)) * 
        cos(radians(p.latitude)) * 
        cos(radians(p.longitude) - radians(user_lng)) + 
        sin(radians(user_lat)) * 
        sin(radians(p.latitude))
      )
    ) <= radius_km
  ORDER BY distance
  LIMIT result_limit;
END;
$$ LANGUAGE plpgsql;

-- Grant execute permission on the function
GRANT EXECUTE ON FUNCTION find_nearby_users TO authenticated;
GRANT EXECUTE ON FUNCTION find_nearby_users TO anon;

-- Add RLS policies for location data (optional - for security)
-- Drop existing policies if they exist, then create new ones
DROP POLICY IF EXISTS "Users can update own location" ON profiles;
DROP POLICY IF EXISTS "Users can view others location" ON profiles;

-- Users can only update their own location
CREATE POLICY "Users can update own location" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- Users can view location data of other users (for nearby search)
CREATE POLICY "Users can view others location" ON profiles
  FOR SELECT USING (true);
