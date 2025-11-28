-- Add dedicated push notification title/body fields to marketing_campaigns
ALTER TABLE marketing_campaigns
  ADD COLUMN IF NOT EXISTS push_title TEXT,
  ADD COLUMN IF NOT EXISTS push_body TEXT;
