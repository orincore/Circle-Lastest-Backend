-- Adds date_of_birth as the source of truth for user age.
-- profiles.age is kept (many services read it directly - see age-resync
-- worker) but is now always derived from date_of_birth server-side.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS date_of_birth DATE;

CREATE OR REPLACE FUNCTION calculate_age(dob date) RETURNS integer AS $$
  SELECT EXTRACT(YEAR FROM age(CURRENT_DATE, dob))::integer;
$$ LANGUAGE sql IMMUTABLE;
