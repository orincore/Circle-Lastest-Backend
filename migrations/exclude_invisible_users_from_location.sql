-- Update find_nearby_users function to exclude invisible users
-- Drop existing function first
DROP FUNCTION IF EXISTS find_nearby_users(numeric,numeric,numeric,uuid,integer);

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
  about TEXT,
  interests TEXT[],
  needs TEXT[],
  profile_photo_url TEXT,
  instagram_username TEXT,
  password_hash TEXT,
  latitude DECIMAL,
  longitude DECIMAL,
  location_address TEXT,
  location_city TEXT,
  location_country TEXT,
  location_updated_at TIMESTAMPTZ,
  location_preference TEXT,
  age_preference TEXT,
  friendship_location_priority BOOLEAN,
  relationship_distance_flexible BOOLEAN,
  preferences_updated_at TIMESTAMPTZ,
  invisible_mode BOOLEAN,
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
    AND p.first_name IS NOT NULL
    AND p.last_name IS NOT NULL
    AND (p.invisible_mode IS NULL OR p.invisible_mode = false)
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
