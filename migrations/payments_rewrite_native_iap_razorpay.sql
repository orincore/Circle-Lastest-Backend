-- Payments rewrite: drop Cashfree + dummy-gateway tables, introduce a unified
-- subscription/payment model shared by Apple IAP, Google Play Billing, and Razorpay.
-- Applied directly against local Postgres (no live users at time of writing; existing
-- rows in the tables touched here are dev/test data from the Supabase dump, not real
-- customer revenue -- see payment_orders/subscription_transactions inspection during
-- this migration's design).

BEGIN;

-- Detach FKs into tables we're about to drop/recreate.
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_subscription_id_fkey;
ALTER TABLE promotional_subscriptions DROP CONSTRAINT IF EXISTS promotional_subscriptions_subscription_id_fkey;

-- Promotional grants pointed at the old (Cashfree-shaped) user_subscriptions rows;
-- those rows are being dropped, so the grants no longer resolve to anything real.
TRUNCATE TABLE promotional_subscriptions;
TRUNCATE TABLE refunds;

DROP TABLE IF EXISTS subscription_transactions;
DROP TABLE IF EXISTS payment_orders;
DROP TABLE IF EXISTS subscriptions;
DROP TABLE IF EXISTS user_subscriptions;

-- Canonical plan catalog (monthly/yearly), one row per plan, seeded below.
CREATE TABLE subscription_plans (
	plan_id varchar(20) PRIMARY KEY,
	name varchar(100) NOT NULL,
	billing_period varchar(20) NOT NULL CHECK (billing_period IN ('monthly', 'yearly')),
	price_inr numeric(10, 2) NOT NULL,
	razorpay_plan_id varchar(100),
	apple_product_id varchar(150),
	google_product_id varchar(150),
	features jsonb NOT NULL DEFAULT '[]',
	is_active boolean NOT NULL DEFAULT true,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

-- google_product_id / apple_product_id values below must match the subscription
-- product IDs created in Play Console / App Store Connect respectively.
INSERT INTO subscription_plans (plan_id, name, billing_period, price_inr, google_product_id, apple_product_id, features) VALUES
	('monthly', 'Monthly Plan', 'monthly', 176.00, 'circle_premium_monthly', 'com.orincore.Circle.premium.monthly', '["unlimited_messaging","advanced_matching","see_who_liked","priority_support","ad_free"]'),
	('yearly', 'Yearly Plan', 'yearly', 1769.00, 'circle_premium_yearly', 'com.orincore.Circle.premium.yearly', '["unlimited_messaging","advanced_matching","see_who_liked","priority_support","ad_free"]');

-- One row per user's current subscription state, regardless of purchase source.
CREATE TABLE user_subscriptions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	user_id uuid NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
	plan_id varchar(20) NOT NULL REFERENCES subscription_plans(plan_id),
	status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'expired', 'grace_period', 'pending')),
	source varchar(10) NOT NULL CHECK (source IN ('ios', 'android', 'web')),
	started_at timestamptz NOT NULL DEFAULT now(),
	expires_at timestamptz NOT NULL,
	auto_renew boolean NOT NULL DEFAULT true,
	cancelled_at timestamptz,
	apple_original_transaction_id varchar(100),
	apple_transaction_id varchar(100),
	google_purchase_token text,
	google_order_id varchar(150),
	razorpay_subscription_id varchar(100),
	razorpay_customer_id varchar(100),
	amount numeric(10, 2),
	currency varchar(3) DEFAULT 'INR',
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_subscriptions_status ON user_subscriptions USING btree (status);
CREATE INDEX idx_user_subscriptions_expires_at ON user_subscriptions USING btree (expires_at);
CREATE INDEX idx_user_subscriptions_apple_original_transaction_id ON user_subscriptions USING btree (apple_original_transaction_id);
CREATE INDEX idx_user_subscriptions_google_purchase_token ON user_subscriptions USING btree (google_purchase_token);
CREATE INDEX idx_user_subscriptions_razorpay_subscription_id ON user_subscriptions USING btree (razorpay_subscription_id);

-- Unified payment ledger, replacing payment_orders + subscription_transactions.
CREATE TABLE payment_transactions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
	subscription_id uuid REFERENCES user_subscriptions(id) ON DELETE SET NULL,
	source varchar(10) NOT NULL CHECK (source IN ('ios', 'android', 'web')),
	amount numeric(10, 2) NOT NULL,
	currency varchar(3) NOT NULL DEFAULT 'INR',
	status varchar(20) NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'success', 'failed', 'refunded')),
	external_transaction_id varchar(150),
	raw_payload jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_transactions_user_id ON payment_transactions USING btree (user_id);
CREATE INDEX idx_payment_transactions_subscription_id ON payment_transactions USING btree (subscription_id);
CREATE INDEX idx_payment_transactions_external_transaction_id ON payment_transactions USING btree (external_transaction_id);
CREATE INDEX idx_payment_transactions_created_at ON payment_transactions USING btree (created_at DESC);

-- Re-point refunds at the new subscription/transaction tables.
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS transaction_id uuid REFERENCES payment_transactions(id);
ALTER TABLE refunds ALTER COLUMN currency SET DEFAULT 'INR';
ALTER TABLE refunds ADD CONSTRAINT refunds_subscription_id_fkey
	FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id) ON DELETE CASCADE;

-- Re-point promotional grants at the recreated user_subscriptions table.
ALTER TABLE promotional_subscriptions ADD CONSTRAINT promotional_subscriptions_subscription_id_fkey
	FOREIGN KEY (subscription_id) REFERENCES user_subscriptions(id) ON DELETE CASCADE;

-- is_refund_eligible() queried the now-dropped `subscriptions` table and checked
-- plan_type = 'free'; user_subscriptions has no 'free' rows (a user with no row at
-- all simply has no subscription to refund), so that check is dropped too.
CREATE OR REPLACE FUNCTION public.is_refund_eligible(subscription_uuid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
    sub_record RECORD;
    days_since_purchase INTEGER;
BEGIN
    SELECT * INTO sub_record
    FROM user_subscriptions
    WHERE id = subscription_uuid;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    days_since_purchase := EXTRACT(DAY FROM NOW() - sub_record.started_at);

    IF days_since_purchase > 7 THEN
        RETURN FALSE;
    END IF;

    IF EXISTS (
        SELECT 1 FROM refunds
        WHERE subscription_id = subscription_uuid
        AND status IN ('approved', 'processed')
    ) THEN
        RETURN FALSE;
    END IF;

    RETURN TRUE;
END;
$function$;

COMMIT;
