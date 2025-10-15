-- =====================================================
-- Referral System Database Schema for Circle App
-- Compatible with Supabase/PostgreSQL
-- =====================================================

-- Table to store user referral codes
CREATE TABLE IF NOT EXISTS user_referrals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    referral_code VARCHAR(12) UNIQUE NOT NULL,
    total_referrals INTEGER DEFAULT 0,
    total_earnings DECIMAL(10, 2) DEFAULT 0.00,
    pending_earnings DECIMAL(10, 2) DEFAULT 0.00,
    paid_earnings DECIMAL(10, 2) DEFAULT 0.00,
    upi_id VARCHAR(100),
    upi_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_user_referral UNIQUE(user_id)
);

-- Table to track individual referrals
CREATE TABLE IF NOT EXISTS referral_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_number VARCHAR(20) UNIQUE NOT NULL, -- Unique tracking number like REF-2025-XXXXX
    referrer_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    referred_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    referral_code VARCHAR(12) NOT NULL,
    reward_amount DECIMAL(10, 2) DEFAULT 10.00,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'paid')),
    rejection_reason TEXT,
    verified_by UUID REFERENCES profiles(id), -- Admin who verified
    verified_at TIMESTAMPTZ,
    payment_date TIMESTAMPTZ,
    payment_reference VARCHAR(100),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_referral UNIQUE(referrer_user_id, referred_user_id)
);

-- Table to track UPI payment requests
CREATE TABLE IF NOT EXISTS referral_payment_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    upi_id VARCHAR(100) NOT NULL,
    amount DECIMAL(10, 2) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    request_date TIMESTAMPTZ DEFAULT NOW(),
    processed_date TIMESTAMPTZ,
    processed_by UUID REFERENCES profiles(id),
    payment_reference VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table to track referral code usage attempts (for analytics)
CREATE TABLE IF NOT EXISTS referral_code_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    referral_code VARCHAR(12) NOT NULL,
    attempted_by_user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    ip_address VARCHAR(45),
    user_agent TEXT,
    success BOOLEAN DEFAULT FALSE,
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX idx_user_referrals_user_id ON user_referrals(user_id);
CREATE INDEX idx_user_referrals_code ON user_referrals(referral_code);
CREATE INDEX idx_referral_transactions_referrer ON referral_transactions(referrer_user_id);
CREATE INDEX idx_referral_transactions_referred ON referral_transactions(referred_user_id);
CREATE INDEX idx_referral_transactions_status ON referral_transactions(status);
CREATE INDEX idx_referral_transactions_number ON referral_transactions(referral_number);
CREATE INDEX idx_payment_requests_user ON referral_payment_requests(user_id);
CREATE INDEX idx_payment_requests_status ON referral_payment_requests(status);

-- Function to generate unique referral code
CREATE OR REPLACE FUNCTION generate_referral_code()
RETURNS VARCHAR(12) AS $$
DECLARE
    v_code VARCHAR(12);
    v_exists BOOLEAN;
    v_random_suffix TEXT;
BEGIN
    LOOP
        -- Generate code: CIR + 6 random uppercase alphanumeric chars
        v_random_suffix := UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 6));
        v_code := 'CIR' || v_random_suffix;
        
        -- Check if code already exists
        SELECT EXISTS(SELECT 1 FROM user_referrals WHERE referral_code = v_code) INTO v_exists;
        
        EXIT WHEN NOT v_exists;
    END LOOP;
    
    RETURN v_code;
END;
$$ LANGUAGE plpgsql;

-- Function to generate unique referral transaction number
CREATE OR REPLACE FUNCTION generate_referral_number()
RETURNS VARCHAR(20) AS $$
DECLARE
    v_number VARCHAR(20);
    v_exists BOOLEAN;
    v_year VARCHAR(4);
    v_sequence VARCHAR(6);
BEGIN
    v_year := TO_CHAR(CURRENT_DATE, 'YYYY');
    
    LOOP
        -- Generate number: REF-YYYY-XXXXXX (6 digit random)
        v_sequence := LPAD(FLOOR(RANDOM() * 999999)::TEXT, 6, '0');
        v_number := 'REF-' || v_year || '-' || v_sequence;
        
        -- Check if number already exists
        SELECT EXISTS(SELECT 1 FROM referral_transactions WHERE referral_number = v_number) INTO v_exists;
        
        EXIT WHEN NOT v_exists;
    END LOOP;
    
    RETURN v_number;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-generate referral code when profile is created
CREATE OR REPLACE FUNCTION create_user_referral_code()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_referrals (user_id, referral_code)
    VALUES (NEW.id, generate_referral_code());
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_create_referral_code
AFTER INSERT ON profiles
FOR EACH ROW
EXECUTE FUNCTION create_user_referral_code();

-- Trigger to update referral statistics
CREATE OR REPLACE FUNCTION update_referral_stats()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Increment total referrals
        UPDATE user_referrals
        SET total_referrals = total_referrals + 1,
            pending_earnings = pending_earnings + NEW.reward_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = NEW.referrer_user_id;
        
    ELSIF TG_OP = 'UPDATE' THEN
        -- Update earnings based on status change
        IF OLD.status = 'pending' AND NEW.status = 'approved' THEN
            -- Move from pending to approved (no change in pending, just status)
            UPDATE user_referrals
            SET updated_at = CURRENT_TIMESTAMP
            WHERE user_id = NEW.referrer_user_id;
            
        ELSIF OLD.status = 'approved' AND NEW.status = 'paid' THEN
            -- Move from pending to paid
            UPDATE user_referrals
            SET pending_earnings = pending_earnings - NEW.reward_amount,
                paid_earnings = paid_earnings + NEW.reward_amount,
                total_earnings = total_earnings + NEW.reward_amount,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = NEW.referrer_user_id;
            
        ELSIF OLD.status IN ('pending', 'approved') AND NEW.status = 'rejected' THEN
            -- Remove from pending if rejected
            UPDATE user_referrals
            SET pending_earnings = pending_earnings - NEW.reward_amount,
                total_referrals = total_referrals - 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE user_id = NEW.referrer_user_id;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_referral_stats
AFTER INSERT OR UPDATE ON referral_transactions
FOR EACH ROW
EXECUTE FUNCTION update_referral_stats();

-- Trigger to update timestamps
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_referrals_updated_at BEFORE UPDATE ON user_referrals
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_referral_transactions_updated_at BEFORE UPDATE ON referral_transactions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_requests_updated_at BEFORE UPDATE ON referral_payment_requests
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- View for referral dashboard
CREATE OR REPLACE VIEW referral_dashboard AS
SELECT 
    ur.user_id,
    p.username,
    p.email,
    ur.referral_code,
    ur.total_referrals,
    ur.total_earnings,
    ur.pending_earnings,
    ur.paid_earnings,
    ur.upi_id,
    ur.upi_verified,
    COUNT(CASE WHEN rt.status = 'pending' THEN 1 END) as pending_count,
    COUNT(CASE WHEN rt.status = 'approved' THEN 1 END) as approved_count,
    COUNT(CASE WHEN rt.status = 'paid' THEN 1 END) as paid_count,
    COUNT(CASE WHEN rt.status = 'rejected' THEN 1 END) as rejected_count
FROM user_referrals ur
JOIN profiles p ON ur.user_id = p.id
LEFT JOIN referral_transactions rt ON ur.user_id = rt.referrer_user_id
GROUP BY ur.user_id, p.username, p.email, ur.referral_code, ur.total_referrals, 
         ur.total_earnings, ur.pending_earnings, ur.paid_earnings, ur.upi_id, ur.upi_verified;

-- Sample queries for common operations

-- Get user's referral info
-- SELECT * FROM user_referrals WHERE user_id = ?;

-- Get user's referral transactions
-- SELECT * FROM referral_transactions WHERE referrer_user_id = ? ORDER BY created_at DESC;

-- Validate referral code
-- SELECT user_id FROM user_referrals WHERE referral_code = ?;

-- Create new referral transaction
-- INSERT INTO referral_transactions (referral_number, referrer_user_id, referred_user_id, referral_code)
-- VALUES (generate_referral_number(), ?, ?, ?);

-- Update referral status
-- UPDATE referral_transactions 
-- SET status = ?, rejection_reason = ?, verified_by = ?, verified_at = CURRENT_TIMESTAMP
-- WHERE id = ?;

-- Get pending referrals for admin review
-- SELECT * FROM referral_transactions WHERE status = 'pending' ORDER BY created_at ASC;

COMMENT ON TABLE user_referrals IS 'Stores user referral codes and earnings summary';
COMMENT ON TABLE referral_transactions IS 'Tracks individual referral transactions with status';
COMMENT ON TABLE referral_payment_requests IS 'Tracks UPI payment requests for referral earnings';
COMMENT ON TABLE referral_code_attempts IS 'Logs all referral code usage attempts for analytics';
