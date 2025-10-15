-- =====================================================
-- Fix Referral Earnings Calculation
-- Comprehensive trigger to handle all status transitions
-- =====================================================

-- Drop existing trigger and function
DROP TRIGGER IF EXISTS trigger_update_referral_stats ON referral_transactions;
DROP FUNCTION IF EXISTS update_referral_stats();

-- Create improved function to handle all status transitions
CREATE OR REPLACE FUNCTION update_referral_stats()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle INSERT (new referral created)
    IF TG_OP = 'INSERT' THEN
        UPDATE user_referrals
        SET total_referrals = total_referrals + 1,
            pending_earnings = pending_earnings + NEW.reward_amount,
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = NEW.referrer_user_id;
        
        RETURN NEW;
    END IF;
    
    -- Handle UPDATE (status change)
    IF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
        
        -- First, reverse the old status effects
        CASE OLD.status
            WHEN 'pending' THEN
                -- Remove from pending
                UPDATE user_referrals
                SET pending_earnings = pending_earnings - OLD.reward_amount
                WHERE user_id = OLD.referrer_user_id;
                
            WHEN 'approved' THEN
                -- Remove from pending (approved items are still in pending_earnings)
                UPDATE user_referrals
                SET pending_earnings = pending_earnings - OLD.reward_amount
                WHERE user_id = OLD.referrer_user_id;
                
            WHEN 'paid' THEN
                -- Remove from paid and total
                UPDATE user_referrals
                SET paid_earnings = paid_earnings - OLD.reward_amount,
                    total_earnings = total_earnings - OLD.reward_amount
                WHERE user_id = OLD.referrer_user_id;
                
            WHEN 'rejected' THEN
                -- Remove from total_referrals count
                UPDATE user_referrals
                SET total_referrals = total_referrals + 1
                WHERE user_id = OLD.referrer_user_id;
        END CASE;
        
        -- Then, apply the new status effects
        CASE NEW.status
            WHEN 'pending' THEN
                -- Add to pending
                UPDATE user_referrals
                SET pending_earnings = pending_earnings + NEW.reward_amount,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = NEW.referrer_user_id;
                
            WHEN 'approved' THEN
                -- Add to pending (approved items stay in pending until paid)
                UPDATE user_referrals
                SET pending_earnings = pending_earnings + NEW.reward_amount,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = NEW.referrer_user_id;
                
            WHEN 'paid' THEN
                -- Add to paid and total
                UPDATE user_referrals
                SET paid_earnings = paid_earnings + NEW.reward_amount,
                    total_earnings = total_earnings + NEW.reward_amount,
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = NEW.referrer_user_id;
                
            WHEN 'rejected' THEN
                -- Decrease total_referrals count
                UPDATE user_referrals
                SET total_referrals = GREATEST(total_referrals - 1, 0),
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = NEW.referrer_user_id;
        END CASE;
        
    END IF;
    
    -- Handle DELETE (referral removed)
    IF TG_OP = 'DELETE' THEN
        CASE OLD.status
            WHEN 'pending', 'approved' THEN
                UPDATE user_referrals
                SET total_referrals = GREATEST(total_referrals - 1, 0),
                    pending_earnings = GREATEST(pending_earnings - OLD.reward_amount, 0),
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = OLD.referrer_user_id;
                
            WHEN 'paid' THEN
                UPDATE user_referrals
                SET total_referrals = GREATEST(total_referrals - 1, 0),
                    paid_earnings = GREATEST(paid_earnings - OLD.reward_amount, 0),
                    total_earnings = GREATEST(total_earnings - OLD.reward_amount, 0),
                    updated_at = CURRENT_TIMESTAMP
                WHERE user_id = OLD.referrer_user_id;
                
            WHEN 'rejected' THEN
                -- Rejected referrals don't affect earnings, just count
                UPDATE user_referrals
                SET updated_at = CURRENT_TIMESTAMP
                WHERE user_id = OLD.referrer_user_id;
        END CASE;
        
        RETURN OLD;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
CREATE TRIGGER trigger_update_referral_stats
AFTER INSERT OR UPDATE OR DELETE ON referral_transactions
FOR EACH ROW
EXECUTE FUNCTION update_referral_stats();

-- =====================================================
-- Recalculate all existing earnings (data fix)
-- =====================================================

-- Reset all earnings to zero first
UPDATE user_referrals
SET total_referrals = 0,
    pending_earnings = 0,
    paid_earnings = 0,
    total_earnings = 0;

-- Recalculate from referral_transactions
WITH referral_stats AS (
    SELECT 
        referrer_user_id,
        COUNT(*) FILTER (WHERE status IN ('pending', 'approved', 'paid')) as total_refs,
        COALESCE(SUM(reward_amount) FILTER (WHERE status IN ('pending', 'approved')), 0) as pending,
        COALESCE(SUM(reward_amount) FILTER (WHERE status = 'paid'), 0) as paid,
        COALESCE(SUM(reward_amount) FILTER (WHERE status = 'paid'), 0) as total
    FROM referral_transactions
    GROUP BY referrer_user_id
)
UPDATE user_referrals ur
SET 
    total_referrals = rs.total_refs,
    pending_earnings = rs.pending,
    paid_earnings = rs.paid,
    total_earnings = rs.total,
    updated_at = CURRENT_TIMESTAMP
FROM referral_stats rs
WHERE ur.user_id = rs.referrer_user_id;

-- =====================================================
-- Verification Query
-- =====================================================

-- Run this to verify the fix worked:
-- SELECT 
--     ur.user_id,
--     ur.referral_code,
--     ur.total_referrals,
--     ur.pending_earnings,
--     ur.paid_earnings,
--     ur.total_earnings,
--     (SELECT COUNT(*) FROM referral_transactions WHERE referrer_user_id = ur.user_id AND status IN ('pending', 'approved', 'paid')) as actual_total_refs,
--     (SELECT COALESCE(SUM(reward_amount), 0) FROM referral_transactions WHERE referrer_user_id = ur.user_id AND status IN ('pending', 'approved')) as actual_pending,
--     (SELECT COALESCE(SUM(reward_amount), 0) FROM referral_transactions WHERE referrer_user_id = ur.user_id AND status = 'paid') as actual_paid
-- FROM user_referrals ur
-- WHERE total_referrals > 0 OR pending_earnings > 0 OR paid_earnings > 0;

COMMENT ON FUNCTION update_referral_stats() IS 'Comprehensive trigger function to handle all referral status transitions and maintain accurate earnings calculations';
