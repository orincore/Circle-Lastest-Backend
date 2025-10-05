-- Create email OTPs table for email verification
CREATE TABLE IF NOT EXISTS email_otps (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email TEXT NOT NULL,
  otp TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER DEFAULT 0,
  verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_email_otps_email ON email_otps(email);
CREATE INDEX IF NOT EXISTS idx_email_otps_expires_at ON email_otps(expires_at);
CREATE INDEX IF NOT EXISTS idx_email_otps_verified ON email_otps(verified);

-- Create unique constraint to prevent duplicate active OTPs
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_otps_unique_active 
ON email_otps(email) WHERE verified = FALSE;

-- Enable Row Level Security
ALTER TABLE email_otps ENABLE ROW LEVEL SECURITY;

-- Create policy: Users can only access their own OTP records
CREATE POLICY email_otps_user_policy ON email_otps
  FOR ALL
  USING (email = auth.jwt() ->> 'email');

-- Create policy: Service role can access all OTP records
CREATE POLICY email_otps_service_policy ON email_otps
  FOR ALL
  USING (auth.role() = 'service_role');

-- Add email_verified column to profiles table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'profiles' AND column_name = 'email_verified') THEN
        ALTER TABLE profiles ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Add email_verified_at column to profiles table
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'profiles' AND column_name = 'email_verified_at') THEN
        ALTER TABLE profiles ADD COLUMN email_verified_at TIMESTAMPTZ;
    END IF;
END $$;

-- Create function to update profiles when email is verified
CREATE OR REPLACE FUNCTION mark_email_verified()
RETURNS TRIGGER AS $$
BEGIN
  -- When an OTP is marked as verified, update the user's profile
  IF NEW.verified = TRUE AND OLD.verified = FALSE THEN
    UPDATE profiles 
    SET 
      email_verified = TRUE,
      email_verified_at = NOW()
    WHERE email = NEW.email;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create trigger to automatically update profile when OTP is verified
CREATE TRIGGER trigger_mark_email_verified
  AFTER UPDATE ON email_otps
  FOR EACH ROW
  EXECUTE FUNCTION mark_email_verified();

-- Create function to clean up expired OTPs (to be run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_otps()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM email_otps 
  WHERE expires_at < NOW() 
    AND verified = FALSE;
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to get OTP status for an email
CREATE OR REPLACE FUNCTION get_otp_status(user_email TEXT)
RETURNS TABLE (
  has_otp BOOLEAN,
  is_verified BOOLEAN,
  is_expired BOOLEAN,
  attempts_count INTEGER,
  time_remaining_minutes INTEGER
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    CASE WHEN otp.email IS NOT NULL THEN TRUE ELSE FALSE END as has_otp,
    COALESCE(otp.verified, FALSE) as is_verified,
    CASE WHEN otp.expires_at < NOW() THEN TRUE ELSE FALSE END as is_expired,
    COALESCE(otp.attempts, 0) as attempts_count,
    CASE 
      WHEN otp.expires_at > NOW() THEN 
        EXTRACT(EPOCH FROM (otp.expires_at - NOW()))::INTEGER / 60
      ELSE 0 
    END as time_remaining_minutes
  FROM email_otps otp
  WHERE otp.email = user_email
    AND otp.verified = FALSE
  ORDER BY otp.created_at DESC
  LIMIT 1;
  
  -- If no record found, return default values
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE, FALSE, 0, 0;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create function to resend OTP (with rate limiting)
CREATE OR REPLACE FUNCTION can_resend_otp(user_email TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  last_otp_time TIMESTAMPTZ;
BEGIN
  -- Get the time of the last OTP sent
  SELECT created_at INTO last_otp_time
  FROM email_otps
  WHERE email = user_email
  ORDER BY created_at DESC
  LIMIT 1;
  
  -- If no OTP exists, allow sending
  IF last_otp_time IS NULL THEN
    RETURN TRUE;
  END IF;
  
  -- Allow resending if more than 1 minute has passed
  RETURN (NOW() - last_otp_time) > INTERVAL '1 minute';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant permissions
GRANT SELECT, INSERT, UPDATE, DELETE ON email_otps TO authenticated;
GRANT ALL ON email_otps TO service_role;

-- Add comments for documentation
COMMENT ON TABLE email_otps IS 'Stores email verification OTP codes for user registration';
COMMENT ON COLUMN email_otps.email IS 'Email address to be verified';
COMMENT ON COLUMN email_otps.otp IS '6-digit verification code';
COMMENT ON COLUMN email_otps.expires_at IS 'When the OTP expires (10 minutes from creation)';
COMMENT ON COLUMN email_otps.attempts IS 'Number of failed verification attempts (max 5)';
COMMENT ON COLUMN email_otps.verified IS 'Whether the OTP has been successfully verified';

-- Create a scheduled job to clean up expired OTPs (if pg_cron is available)
-- SELECT cron.schedule('cleanup-expired-otps', '0 * * * *', 'SELECT cleanup_expired_otps();');
