-- Face Verification System
-- Tracks user verification status and attempts

-- Create verification status enum
CREATE TYPE verification_status AS ENUM ('pending', 'verified', 'rejected', 'expired');

-- Create face verification table
CREATE TABLE IF NOT EXISTS face_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    status verification_status NOT NULL DEFAULT 'pending',
    
    -- Verification attempt data
    video_s3_key TEXT,
    verification_data JSONB,  -- Stores full verification response
    confidence DECIMAL(3, 2),
    movements_detected TEXT[],
    
    -- Timestamps
    submitted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    verified_at TIMESTAMP WITH TIME ZONE,
    expires_at TIMESTAMP WITH TIME ZONE DEFAULT (NOW() + INTERVAL '24 hours'),
    
    -- Admin review
    reviewed_by UUID REFERENCES profiles(id),
    review_notes TEXT,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    ip_address INET,
    user_agent TEXT,
    device_info JSONB,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX idx_face_verifications_user_id ON face_verifications(user_id);
CREATE INDEX idx_face_verifications_status ON face_verifications(status);
CREATE INDEX idx_face_verifications_submitted_at ON face_verifications(submitted_at DESC);

-- Add verification status to profiles
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS verification_status verification_status DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS verified_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS verification_required BOOLEAN DEFAULT TRUE;

-- Create index on profile verification status
CREATE INDEX idx_profiles_verification_status ON profiles(verification_status);

-- Create verification attempts log
CREATE TABLE IF NOT EXISTS verification_attempts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    verification_id UUID REFERENCES face_verifications(id) ON DELETE SET NULL,
    
    success BOOLEAN NOT NULL,
    failure_reason TEXT,
    
    -- Attempt metadata
    ip_address INET,
    user_agent TEXT,
    device_info JSONB,
    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_verification_attempts_user_id ON verification_attempts(user_id);
CREATE INDEX idx_verification_attempts_created_at ON verification_attempts(created_at DESC);

-- Function to update profile verification status
CREATE OR REPLACE FUNCTION update_profile_verification_status()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status = 'verified' AND OLD.status != 'verified' THEN
        UPDATE profiles
        SET 
            verification_status = 'verified',
            verified_at = NOW(),
            updated_at = NOW()
        WHERE id = NEW.user_id;
    ELSIF NEW.status = 'rejected' THEN
        UPDATE profiles
        SET 
            verification_status = 'rejected',
            updated_at = NOW()
        WHERE id = NEW.user_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update profile when verification status changes
CREATE TRIGGER trigger_update_profile_verification
    AFTER UPDATE OF status ON face_verifications
    FOR EACH ROW
    EXECUTE FUNCTION update_profile_verification_status();

-- Function to expire old pending verifications
CREATE OR REPLACE FUNCTION expire_old_verifications()
RETURNS void AS $$
BEGIN
    UPDATE face_verifications
    SET status = 'expired'
    WHERE status = 'pending'
    AND expires_at < NOW();
END;
$$ LANGUAGE plpgsql;

-- Comments
COMMENT ON TABLE face_verifications IS 'Stores face verification attempts and results';
COMMENT ON COLUMN face_verifications.verification_data IS 'Full JSON response from Python verification service';
COMMENT ON COLUMN face_verifications.confidence IS 'Verification confidence score (0.00 to 1.00)';
COMMENT ON TABLE verification_attempts IS 'Logs all verification attempts for audit trail';
