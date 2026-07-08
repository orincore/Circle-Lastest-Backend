-- =====================================================
-- Cashfree Payment System Tables
-- For ₹10/month and ₹50/year subscriptions
-- =====================================================

-- Payment Orders Table
CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id VARCHAR(100) UNIQUE NOT NULL,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    plan_id VARCHAR(50) NOT NULL, -- 'monthly' or 'yearly'
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'INR',
    status VARCHAR(20) DEFAULT 'created', -- created, success, failed, cancelled
    gateway VARCHAR(20) DEFAULT 'cashfree',
    gateway_order_id VARCHAR(100),
    gateway_payment_id VARCHAR(100),
    payment_method VARCHAR(50),
    failure_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- User Subscriptions Table (enhanced)
CREATE TABLE IF NOT EXISTS user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    plan_type VARCHAR(20) NOT NULL, -- 'monthly' or 'yearly'
    status VARCHAR(20) DEFAULT 'active', -- active, expired, cancelled
    started_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    cancelled_at TIMESTAMPTZ,
    payment_gateway VARCHAR(20) DEFAULT 'cashfree',
    gateway_subscription_id VARCHAR(100),
    amount DECIMAL(10, 2),
    currency VARCHAR(3) DEFAULT 'INR',
    auto_renew BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT unique_active_subscription UNIQUE(user_id, status)
);

-- Subscription Transactions Table
CREATE TABLE IF NOT EXISTS subscription_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    order_id VARCHAR(100) REFERENCES payment_orders(order_id),
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'INR',
    status VARCHAR(20) NOT NULL, -- completed, failed, refunded
    payment_method VARCHAR(50),
    gateway VARCHAR(20) DEFAULT 'cashfree',
    gateway_transaction_id VARCHAR(100),
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_payment_orders_user_id ON payment_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_created_at ON payment_orders(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_user_id ON user_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_status ON user_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_user_subscriptions_expires_at ON user_subscriptions(expires_at);

CREATE INDEX IF NOT EXISTS idx_subscription_transactions_user_id ON subscription_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscription_transactions_order_id ON subscription_transactions(order_id);
CREATE INDEX IF NOT EXISTS idx_subscription_transactions_created_at ON subscription_transactions(created_at DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_payment_orders_updated_at
    BEFORE UPDATE ON payment_orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_subscriptions_updated_at
    BEFORE UPDATE ON user_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Function to check if user is premium
CREATE OR REPLACE FUNCTION is_premium_user(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    has_active_sub BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM user_subscriptions
        WHERE user_id = p_user_id
        AND status = 'active'
        AND expires_at > NOW()
    ) INTO has_active_sub;
    
    RETURN has_active_sub;
END;
$$ LANGUAGE plpgsql;

-- Function to get user's current subscription
CREATE OR REPLACE FUNCTION get_user_subscription(p_user_id UUID)
RETURNS TABLE (
    plan_type VARCHAR,
    status VARCHAR,
    expires_at TIMESTAMPTZ,
    days_remaining INTEGER
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        us.plan_type,
        us.status,
        us.expires_at,
        EXTRACT(DAY FROM (us.expires_at - NOW()))::INTEGER as days_remaining
    FROM user_subscriptions us
    WHERE us.user_id = p_user_id
    AND us.status = 'active'
    AND us.expires_at > NOW()
    ORDER BY us.expires_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to expire old subscriptions (run via cron)
CREATE OR REPLACE FUNCTION expire_old_subscriptions()
RETURNS INTEGER AS $$
DECLARE
    expired_count INTEGER;
BEGIN
    UPDATE user_subscriptions
    SET status = 'expired',
        updated_at = NOW()
    WHERE status = 'active'
    AND expires_at < NOW();
    
    GET DIAGNOSTICS expired_count = ROW_COUNT;
    RETURN expired_count;
END;
$$ LANGUAGE plpgsql;

-- Add subscription status to profiles (optional, for quick access)
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMPTZ;

-- Trigger to update profile premium status
CREATE OR REPLACE FUNCTION update_profile_premium_status()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        UPDATE profiles
        SET is_premium = (NEW.status = 'active' AND NEW.expires_at > NOW()),
            subscription_expires_at = CASE 
                WHEN NEW.status = 'active' THEN NEW.expires_at 
                ELSE NULL 
            END
        WHERE id = NEW.user_id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_profile_premium_status
AFTER INSERT OR UPDATE ON user_subscriptions
FOR EACH ROW
EXECUTE FUNCTION update_profile_premium_status();

-- Sample data for testing (optional)
-- INSERT INTO payment_orders (order_id, user_id, plan_id, amount, status) 
-- VALUES ('TEST_ORDER_001', 'your-user-id', 'monthly', 10.00, 'created');

COMMENT ON TABLE payment_orders IS 'Stores Cashfree payment orders for subscriptions';
COMMENT ON TABLE user_subscriptions IS 'Stores active user subscriptions';
COMMENT ON TABLE subscription_transactions IS 'Stores all subscription payment transactions';
COMMENT ON FUNCTION is_premium_user(UUID) IS 'Check if user has active premium subscription';
COMMENT ON FUNCTION get_user_subscription(UUID) IS 'Get user''s current active subscription details';
COMMENT ON FUNCTION expire_old_subscriptions() IS 'Expire subscriptions past their expiry date';
