-- Create refunds table for subscription refund management
CREATE TABLE IF NOT EXISTS refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    reason TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processed', 'failed')),
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    processed_by UUID REFERENCES profiles(id), -- Admin who processed the refund
    payment_provider VARCHAR(50), -- 'stripe', 'apple', 'google', etc.
    external_refund_id VARCHAR(255), -- ID from payment provider
    refund_method VARCHAR(50) DEFAULT 'original_payment_method', -- How refund is processed
    admin_notes TEXT, -- Internal notes for admin
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_refunds_subscription_id ON refunds(subscription_id);
CREATE INDEX IF NOT EXISTS idx_refunds_user_id ON refunds(user_id);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status);
CREATE INDEX IF NOT EXISTS idx_refunds_requested_at ON refunds(requested_at);
CREATE INDEX IF NOT EXISTS idx_refunds_processed_by ON refunds(processed_by);

-- Create trigger for updated_at
DROP TRIGGER IF EXISTS update_refunds_updated_at ON refunds;
CREATE TRIGGER update_refunds_updated_at
    BEFORE UPDATE ON refunds
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add refund eligibility check function
CREATE OR REPLACE FUNCTION is_refund_eligible(subscription_uuid UUID)
RETURNS BOOLEAN AS $$
DECLARE
    sub_record RECORD;
    days_since_purchase INTEGER;
BEGIN
    -- Get subscription details
    SELECT * INTO sub_record
    FROM subscriptions 
    WHERE id = subscription_uuid;
    
    -- Check if subscription exists
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    
    -- Check if subscription is premium (not free)
    IF sub_record.plan_type = 'free' THEN
        RETURN FALSE;
    END IF;
    
    -- Calculate days since purchase
    days_since_purchase := EXTRACT(DAY FROM NOW() - sub_record.started_at);
    
    -- Check if within 7-day window
    IF days_since_purchase > 7 THEN
        RETURN FALSE;
    END IF;
    
    -- Check if already refunded
    IF EXISTS (
        SELECT 1 FROM refunds 
        WHERE subscription_id = subscription_uuid 
        AND status IN ('approved', 'processed')
    ) THEN
        RETURN FALSE;
    END IF;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Add function to get refund statistics
CREATE OR REPLACE FUNCTION get_refund_stats()
RETURNS JSON AS $$
DECLARE
    result JSON;
BEGIN
    SELECT json_build_object(
        'total_requests', COUNT(*),
        'pending', COUNT(*) FILTER (WHERE status = 'pending'),
        'approved', COUNT(*) FILTER (WHERE status = 'approved'),
        'rejected', COUNT(*) FILTER (WHERE status = 'rejected'),
        'processed', COUNT(*) FILTER (WHERE status = 'processed'),
        'failed', COUNT(*) FILTER (WHERE status = 'failed'),
        'total_amount', COALESCE(SUM(amount) FILTER (WHERE status IN ('approved', 'processed')), 0),
        'pending_amount', COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)
    ) INTO result
    FROM refunds;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE refunds IS 'Subscription refund requests and processing records';
COMMENT ON FUNCTION is_refund_eligible(UUID) IS 'Check if a subscription is eligible for refund (within 7 days, not already refunded)';
COMMENT ON FUNCTION get_refund_stats() IS 'Get refund statistics for admin dashboard';
