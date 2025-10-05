-- Create subscriptions table for premium features
CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    plan_type VARCHAR(20) NOT NULL DEFAULT 'free' CHECK (plan_type IN ('free', 'premium', 'premium_plus')),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'pending')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    payment_provider VARCHAR(50), -- 'stripe', 'apple', 'google', etc.
    external_subscription_id VARCHAR(255), -- ID from payment provider
    price_paid DECIMAL(10,2),
    currency VARCHAR(3) DEFAULT 'USD',
    auto_renew BOOLEAN DEFAULT true,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(user_id) -- One active subscription per user
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_expires_at ON subscriptions(expires_at);

-- Create daily match limits tracking table
CREATE TABLE IF NOT EXISTS daily_match_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    matches_made INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    UNIQUE(user_id, date) -- One record per user per day
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_daily_match_limits_user_date ON daily_match_limits(user_id, date);

-- Add subscription_plan column to profiles table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'subscription_plan') THEN
        ALTER TABLE profiles ADD COLUMN subscription_plan VARCHAR(20) DEFAULT 'free' CHECK (subscription_plan IN ('free', 'premium', 'premium_plus'));
    END IF;
END $$;

-- Add premium_expires_at column to profiles table if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'premium_expires_at') THEN
        ALTER TABLE profiles ADD COLUMN premium_expires_at TIMESTAMPTZ;
    END IF;
END $$;

-- Create function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create triggers for updated_at
DROP TRIGGER IF EXISTS update_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER update_subscriptions_updated_at
    BEFORE UPDATE ON subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_daily_match_limits_updated_at ON daily_match_limits;
CREATE TRIGGER update_daily_match_limits_updated_at
    BEFORE UPDATE ON daily_match_limits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Insert default free subscriptions for existing profiles
INSERT INTO subscriptions (user_id, plan_type, status, started_at)
SELECT id, 'free', 'active', created_at
FROM profiles 
WHERE id NOT IN (SELECT user_id FROM subscriptions)
ON CONFLICT (user_id) DO NOTHING;

-- Update profiles table with subscription info
UPDATE profiles 
SET subscription_plan = 'free' 
WHERE subscription_plan IS NULL;

COMMENT ON TABLE subscriptions IS 'User subscription plans and billing information';
COMMENT ON TABLE daily_match_limits IS 'Daily match limits tracking for free users';
