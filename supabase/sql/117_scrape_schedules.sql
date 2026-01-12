-- Migration: Add scrape_schedules table for configurable cron timings
-- Stores schedule configurations that cron handlers read from

CREATE TABLE IF NOT EXISTS scrape_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE, -- e.g. 'check_stock_fix', 'scrape_statistics', 'scrape_purchase_orders'
  name TEXT NOT NULL, -- Human-readable name
  description TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Schedule config (Copenhagen time)
  hours INTEGER[] NOT NULL DEFAULT '{}', -- Array of hours to run (0-23)
  days_of_week INTEGER[] DEFAULT NULL, -- NULL = every day, [0]=Sunday, [1]=Monday, etc.
  -- Additional config
  config JSONB DEFAULT '{}', -- Job-specific config (e.g. toggles, modes)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE scrape_schedules ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read
CREATE POLICY "scrape_schedules_select_authenticated" ON scrape_schedules
  FOR SELECT TO authenticated USING (true);

-- Allow authenticated users to update (admin only in practice)
CREATE POLICY "scrape_schedules_update_authenticated" ON scrape_schedules
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- Allow service role full access
CREATE POLICY "scrape_schedules_service_role_all" ON scrape_schedules
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Insert default schedules
INSERT INTO scrape_schedules (key, name, description, enabled, hours, days_of_week, config) VALUES
  -- Daily schedules (all days)
  ('check_stock_fix', 'Check Stock Fix', 'Compare SPY stock with database and auto-fix mismatches', true, '{7,12,15}', NULL, '{"minuteOffset": 30, "autoFix": true}'),
  ('scrape_statistics', 'Scrape Statistics', 'Scrape sales statistics from SPY', true, '{7,9,11,13,15}', NULL, '{"styleDetailsHours": [7,15]}'),
  ('scrape_purchase_orders', 'Sync Purchase Orders', 'Sync PO data from SPY', true, '{7,12,15}', NULL, '{}'),
  ('export_statistics', 'Export Statistics PDFs', 'Generate and export statistics PDFs', true, '{7,15}', NULL, '{}'),
  
  -- Weekly schedules (Sundays only)
  ('weekly_style_refresh', 'Weekly Style Refresh', 'Full style data refresh pipeline (scrape → enrich → EANs → stock)', true, '{2}', '{0}', '{}'),
  ('weekly_customer_sync', 'Weekly Customer Sync', 'Sync customer data and flag orphaned customers', true, '{4}', '{0}', '{}')
ON CONFLICT (key) DO NOTHING;

-- Function to get schedule for a given key
CREATE OR REPLACE FUNCTION get_scrape_schedule(p_key TEXT)
RETURNS TABLE(
  enabled BOOLEAN,
  hours INTEGER[],
  days_of_week INTEGER[],
  config JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT s.enabled, s.hours, s.days_of_week, s.config
  FROM scrape_schedules s
  WHERE s.key = p_key;
END;
$$;

GRANT EXECUTE ON FUNCTION get_scrape_schedule(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION get_scrape_schedule(TEXT) TO service_role;

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_scrape_schedules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS scrape_schedules_updated_at ON scrape_schedules;
CREATE TRIGGER scrape_schedules_updated_at
  BEFORE UPDATE ON scrape_schedules
  FOR EACH ROW
  EXECUTE FUNCTION update_scrape_schedules_updated_at();
