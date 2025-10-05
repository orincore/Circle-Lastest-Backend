-- Add missing verified_at column to email_otps table
-- This migration adds the verified_at timestamp column that tracks when an OTP was verified

-- Add the verified_at column
ALTER TABLE email_otps 
ADD COLUMN verified_at TIMESTAMPTZ;

-- Add an index for better query performance
CREATE INDEX IF NOT EXISTS idx_email_otps_verified_at ON email_otps(verified_at);

-- Update existing verified records to have a verified_at timestamp
-- Set verified_at to updated_at for records that are already verified
UPDATE email_otps 
SET verified_at = updated_at 
WHERE verified = true AND verified_at IS NULL;

-- Add a comment to document the column
COMMENT ON COLUMN email_otps.verified_at IS 'Timestamp when the OTP was successfully verified';

-- Optional: Add a trigger to automatically set verified_at when verified is set to true
CREATE OR REPLACE FUNCTION set_verified_at()
RETURNS TRIGGER AS $$
BEGIN
    -- If verified is being set to true and verified_at is null, set it to now
    IF NEW.verified = true AND OLD.verified = false AND NEW.verified_at IS NULL THEN
        NEW.verified_at = NOW();
    END IF;
    
    -- If verified is being set to false, clear verified_at
    IF NEW.verified = false AND OLD.verified = true THEN
        NEW.verified_at = NULL;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
DROP TRIGGER IF EXISTS trigger_set_verified_at ON email_otps;
CREATE TRIGGER trigger_set_verified_at
    BEFORE UPDATE ON email_otps
    FOR EACH ROW
    EXECUTE FUNCTION set_verified_at();

-- Verify the changes
SELECT column_name, data_type, is_nullable 
FROM information_schema.columns 
WHERE table_name = 'email_otps' 
AND column_name = 'verified_at';
