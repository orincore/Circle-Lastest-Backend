-- Fix referral count updates
-- This migration adds a function to increment referral counts and a trigger to auto-update

-- Function to increment referral count
CREATE OR REPLACE FUNCTION increment_referral_count(p_user_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE user_referrals
  SET total_referrals = total_referrals + 1,
      updated_at = NOW()
  WHERE user_id = p_user_id;
END;
$$;

-- Function to automatically update referral counts when a transaction is created
CREATE OR REPLACE FUNCTION update_referral_counts_on_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Increment total_referrals when a new referral transaction is created
  IF TG_OP = 'INSERT' THEN
    UPDATE user_referrals
    SET total_referrals = total_referrals + 1,
        updated_at = NOW()
    WHERE user_id = NEW.referrer_user_id;
  END IF;

  -- Update earnings when status changes
  IF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
    -- When approved, add to pending_earnings
    IF NEW.status = 'approved' THEN
      UPDATE user_referrals
      SET pending_earnings = pending_earnings + COALESCE(NEW.reward_amount, 10),
          updated_at = NOW()
      WHERE user_id = NEW.referrer_user_id;
    END IF;

    -- When paid, move from pending to paid earnings
    IF NEW.status = 'paid' THEN
      UPDATE user_referrals
      SET pending_earnings = pending_earnings - COALESCE(NEW.reward_amount, 10),
          paid_earnings = paid_earnings + COALESCE(NEW.reward_amount, 10),
          total_earnings = total_earnings + COALESCE(NEW.reward_amount, 10),
          updated_at = NOW()
      WHERE user_id = NEW.referrer_user_id;
    END IF;

    -- When rejected, no earnings update needed
  END IF;

  RETURN NEW;
END;
$$;

-- Drop trigger if exists
DROP TRIGGER IF EXISTS trigger_update_referral_counts ON referral_transactions;

-- Create trigger on referral_transactions table
CREATE TRIGGER trigger_update_referral_counts
AFTER INSERT OR UPDATE ON referral_transactions
FOR EACH ROW
EXECUTE FUNCTION update_referral_counts_on_transaction();

-- Fix existing referral counts (one-time migration)
-- Count actual referrals and update user_referrals table
UPDATE user_referrals ur
SET total_referrals = (
  SELECT COUNT(*)
  FROM referral_transactions rt
  WHERE rt.referrer_user_id = ur.user_id
),
pending_earnings = (
  SELECT COALESCE(SUM(reward_amount), 0)
  FROM referral_transactions rt
  WHERE rt.referrer_user_id = ur.user_id
  AND rt.status = 'approved'
),
paid_earnings = (
  SELECT COALESCE(SUM(reward_amount), 0)
  FROM referral_transactions rt
  WHERE rt.referrer_user_id = ur.user_id
  AND rt.status = 'paid'
),
total_earnings = (
  SELECT COALESCE(SUM(reward_amount), 0)
  FROM referral_transactions rt
  WHERE rt.referrer_user_id = ur.user_id
  AND rt.status IN ('approved', 'paid')
),
updated_at = NOW();

-- Add comment
COMMENT ON FUNCTION increment_referral_count IS 'Increments the referral count for a user';
COMMENT ON FUNCTION update_referral_counts_on_transaction IS 'Automatically updates referral counts and earnings when transactions are created or updated';
COMMENT ON TRIGGER trigger_update_referral_counts ON referral_transactions IS 'Automatically updates user_referrals table when referral transactions change';
