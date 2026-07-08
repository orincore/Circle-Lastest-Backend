-- =====================================================
-- Free Subscription Promotion for First 1000 Users
-- =====================================================

-- Table to track promotional subscriptions
CREATE TABLE IF NOT EXISTS promotional_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    promo_type VARCHAR(50) NOT NULL, -- 'first_1000_users'
    granted_at TIMESTAMPTZ DEFAULT NOW(),
    subscription_id UUID REFERENCES user_subscriptions(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, promo_type)
);

-- Index for performance
CREATE INDEX IF NOT EXISTS idx_promotional_subscriptions_user_id ON promotional_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_promotional_subscriptions_promo_type ON promotional_subscriptions(promo_type);
CREATE INDEX IF NOT EXISTS idx_promotional_subscriptions_granted_at ON promotional_subscriptions(granted_at);

-- Function to check if user is eligible for free subscription
CREATE OR REPLACE FUNCTION is_eligible_for_free_subscription(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    already_claimed BOOLEAN;
    total_claimed INTEGER;
BEGIN
    -- Check if user already claimed
    SELECT EXISTS(
        SELECT 1 FROM promotional_subscriptions
        WHERE user_id = p_user_id
        AND promo_type = 'first_1000_users'
    ) INTO already_claimed;
    
    IF already_claimed THEN
        RETURN FALSE;
    END IF;
    
    -- Check if less than 1000 users have claimed
    SELECT COUNT(*) INTO total_claimed
    FROM promotional_subscriptions
    WHERE promo_type = 'first_1000_users';
    
    RETURN total_claimed < 1000;
END;
$$ LANGUAGE plpgsql;

-- Function to get count of free subscriptions claimed
CREATE OR REPLACE FUNCTION get_free_subscription_count()
RETURNS INTEGER AS $$
DECLARE
    count INTEGER;
BEGIN
    SELECT COUNT(*) INTO count
    FROM promotional_subscriptions
    WHERE promo_type = 'first_1000_users';
    
    RETURN count;
END;
$$ LANGUAGE plpgsql;

-- Function to claim free subscription
CREATE OR REPLACE FUNCTION claim_free_subscription(p_user_id UUID)
RETURNS TABLE (
    success BOOLEAN,
    message TEXT,
    subscription_id UUID
) AS $$
DECLARE
    v_is_eligible BOOLEAN;
    v_subscription_id UUID;
    v_expires_at TIMESTAMPTZ;
BEGIN
    -- Check eligibility
    SELECT is_eligible_for_free_subscription(p_user_id) INTO v_is_eligible;
    
    IF NOT v_is_eligible THEN
        RETURN QUERY SELECT FALSE, 'Not eligible for free subscription'::TEXT, NULL::UUID;
        RETURN;
    END IF;
    
    -- Calculate expiry (30 days from now)
    v_expires_at := NOW() + INTERVAL '30 days';
    
    -- Create subscription
    INSERT INTO user_subscriptions (
        user_id,
        plan_type,
        status,
        started_at,
        expires_at,
        payment_gateway,
        amount,
        currency,
        auto_renew
    ) VALUES (
        p_user_id,
        'monthly',
        'active',
        NOW(),
        v_expires_at,
        'promotional',
        0,
        'INR',
        FALSE
    ) RETURNING id INTO v_subscription_id;
    
    -- Record promotional subscription
    INSERT INTO promotional_subscriptions (
        user_id,
        promo_type,
        subscription_id
    ) VALUES (
        p_user_id,
        'first_1000_users',
        v_subscription_id
    );
    
    -- Update profile
    UPDATE profiles
    SET is_premium = TRUE,
        subscription_expires_at = v_expires_at
    WHERE id = p_user_id;
    
    RETURN QUERY SELECT TRUE, 'Free subscription granted successfully'::TEXT, v_subscription_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE promotional_subscriptions IS 'Tracks promotional free subscriptions';
COMMENT ON FUNCTION is_eligible_for_free_subscription(UUID) IS 'Check if user can claim free subscription';
COMMENT ON FUNCTION get_free_subscription_count() IS 'Get count of free subscriptions claimed';
COMMENT ON FUNCTION claim_free_subscription(UUID) IS 'Claim free 1-month subscription for eligible users';
