-- ============================================
-- Beacon Helper Retry System - Database Migration
-- ============================================
-- This migration adds support for:
-- 1. Tracking giver request attempts
-- 2. Retry logic with timeout monitoring
-- 3. Attempt counting for help requests
-- ============================================

-- Create giver_request_attempts table
CREATE TABLE IF NOT EXISTS giver_request_attempts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  help_request_id UUID NOT NULL REFERENCES help_requests(id) ON DELETE CASCADE,
  giver_user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'timeout')),
  notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Ensure required columns exist on legacy installations
ALTER TABLE giver_request_attempts
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE giver_request_attempts
  ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;

ALTER TABLE giver_request_attempts
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE giver_request_attempts
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_giver_attempts_request 
  ON giver_request_attempts(help_request_id);

CREATE INDEX IF NOT EXISTS idx_giver_attempts_giver 
  ON giver_request_attempts(giver_user_id);

CREATE INDEX IF NOT EXISTS idx_giver_attempts_status 
  ON giver_request_attempts(status);

CREATE INDEX IF NOT EXISTS idx_giver_attempts_created 
  ON giver_request_attempts(created_at DESC);

-- Composite index for common queries
CREATE INDEX IF NOT EXISTS idx_giver_attempts_request_status 
  ON giver_request_attempts(help_request_id, status);

-- Add attempts_count column to help_requests if not exists
ALTER TABLE help_requests 
ADD COLUMN IF NOT EXISTS attempts_count INTEGER NOT NULL DEFAULT 0;

-- Add index on attempts_count for analytics
CREATE INDEX IF NOT EXISTS idx_help_requests_attempts 
  ON help_requests(attempts_count);

-- Update existing help_requests to have attempts_count = 0
UPDATE help_requests 
SET attempts_count = 0 
WHERE attempts_count IS NULL;

-- Add trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_giver_attempts_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_update_giver_attempts_timestamp
  BEFORE UPDATE ON giver_request_attempts
  FOR EACH ROW
  EXECUTE FUNCTION update_giver_attempts_updated_at();

-- Add RLS policies for giver_request_attempts
ALTER TABLE giver_request_attempts ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own attempts (as giver)
CREATE POLICY giver_attempts_view_own ON giver_request_attempts
  FOR SELECT
  USING (
    auth.uid() = giver_user_id 
    OR 
    auth.uid() IN (
      SELECT receiver_user_id FROM help_requests WHERE id = help_request_id
    )
  );

-- Policy: System can insert attempts
CREATE POLICY giver_attempts_insert ON giver_request_attempts
  FOR INSERT
  WITH CHECK (true);

-- Policy: System can update attempts
CREATE POLICY giver_attempts_update ON giver_request_attempts
  FOR UPDATE
  USING (true);

-- Add comments for documentation
COMMENT ON TABLE giver_request_attempts IS 'Tracks all attempts to match givers with help requests, including timeouts and responses';
COMMENT ON COLUMN giver_request_attempts.status IS 'pending: waiting for response, accepted: giver accepted, declined: giver declined, timeout: no response within 1 hour';
COMMENT ON COLUMN giver_request_attempts.notified_at IS 'When the giver was notified about this request';
COMMENT ON COLUMN giver_request_attempts.responded_at IS 'When the giver responded (accepted/declined) or when timeout occurred';
COMMENT ON COLUMN help_requests.attempts_count IS 'Number of retry attempts made for this request (max 5)';

-- Create view for analytics
CREATE OR REPLACE VIEW beacon_retry_analytics AS
SELECT 
  hr.id as request_id,
  hr.receiver_user_id,
  hr.prompt,
  hr.status as request_status,
  hr.attempts_count,
  hr.created_at as request_created_at,
  COUNT(gra.id) as total_attempts,
  COUNT(CASE WHEN gra.status = 'accepted' THEN 1 END) as accepted_count,
  COUNT(CASE WHEN gra.status = 'declined' THEN 1 END) as declined_count,
  COUNT(CASE WHEN gra.status = 'timeout' THEN 1 END) as timeout_count,
  COUNT(CASE WHEN gra.status = 'pending' THEN 1 END) as pending_count,
  MIN(gra.notified_at) as first_attempt_at,
  MAX(gra.responded_at) as last_response_at,
  EXTRACT(EPOCH FROM (MAX(gra.responded_at) - MIN(gra.notified_at)))/3600 as total_hours_to_resolve
FROM help_requests hr
LEFT JOIN giver_request_attempts gra ON hr.id = gra.help_request_id
WHERE hr.created_at > NOW() - INTERVAL '30 days'
GROUP BY hr.id, hr.receiver_user_id, hr.prompt, hr.status, hr.attempts_count, hr.created_at;

COMMENT ON VIEW beacon_retry_analytics IS 'Analytics view for beacon retry system performance over last 30 days';

-- Grant permissions
GRANT SELECT ON beacon_retry_analytics TO authenticated;

-- Success message
DO $$
BEGIN
  RAISE NOTICE 'Beacon retry system migration completed successfully!';
  RAISE NOTICE 'Created tables: giver_request_attempts';
  RAISE NOTICE 'Added columns: help_requests.attempts_count';
  RAISE NOTICE 'Created indexes: 6 indexes for performance';
  RAISE NOTICE 'Created views: beacon_retry_analytics';
END $$;
