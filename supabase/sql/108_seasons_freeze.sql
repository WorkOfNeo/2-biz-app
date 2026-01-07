-- Migration: Add freeze columns to seasons table
-- When is_frozen = true, scrape jobs will not write/overwrite data for this season.

ALTER TABLE seasons
  ADD COLUMN IF NOT EXISTS is_frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS frozen_at timestamptz,
  ADD COLUMN IF NOT EXISTS frozen_by text;

COMMENT ON COLUMN seasons.is_frozen IS 'When true, scrape_statistics jobs will skip writes for this season.';
COMMENT ON COLUMN seasons.frozen_at IS 'Timestamp when the season was marked frozen.';
COMMENT ON COLUMN seasons.frozen_by IS 'Email or identifier of user who froze the season.';


