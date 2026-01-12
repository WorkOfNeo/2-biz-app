-- Migration: Add style_stock_totals table for fast stock comparison
-- This table stores aggregated stock totals per style_no for efficient check_stock_fix comparisons

-- Create the totals table
CREATE TABLE IF NOT EXISTS style_stock_totals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  style_no TEXT NOT NULL UNIQUE,
  total_stock INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Add index for fast lookups
CREATE INDEX IF NOT EXISTS idx_style_stock_totals_style_no ON style_stock_totals(style_no);

-- Enable RLS
ALTER TABLE style_stock_totals ENABLE ROW LEVEL SECURITY;

-- Allow read access to authenticated users
CREATE POLICY "style_stock_totals_select_authenticated" ON style_stock_totals
  FOR SELECT TO authenticated USING (true);

-- Allow service role full access for worker updates
CREATE POLICY "style_stock_totals_service_role_all" ON style_stock_totals
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Function to update stock totals for a given style_no
-- Called by update_style_stock worker after upserting stock rows
CREATE OR REPLACE FUNCTION update_style_stock_total(p_style_no TEXT)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_total INTEGER;
BEGIN
  -- Calculate total stock using the same logic as check_stock_fix:
  -- For each (style_no, color), deduplicate by (section, row_label) keeping latest scraped_at,
  -- then sum the values array for section='Stock'
  WITH latest_per_key AS (
    SELECT DISTINCT ON (style_no, color, section, COALESCE(NULLIF(TRIM(row_label), ''), '__unnamed_' || id::text))
      style_no,
      color,
      section,
      values,
      scraped_at
    FROM style_stock
    WHERE style_no = p_style_no
    ORDER BY 
      style_no, 
      color, 
      section, 
      COALESCE(NULLIF(TRIM(row_label), ''), '__unnamed_' || id::text),
      scraped_at DESC
  ),
  stock_rows AS (
    SELECT 
      style_no,
      color,
      values
    FROM latest_per_key
    WHERE section = 'Stock'
  ),
  color_totals AS (
    SELECT 
      style_no,
      color,
      COALESCE(
        (SELECT SUM(v::numeric)::integer 
         FROM jsonb_array_elements_text(values::jsonb) AS v 
         WHERE v ~ '^-?[0-9]+$'),
        0
      ) AS color_total
    FROM stock_rows
  )
  SELECT COALESCE(SUM(color_total), 0) INTO v_total
  FROM color_totals;

  -- Upsert the total
  INSERT INTO style_stock_totals (style_no, total_stock, updated_at)
  VALUES (p_style_no, v_total, now())
  ON CONFLICT (style_no) 
  DO UPDATE SET 
    total_stock = EXCLUDED.total_stock,
    updated_at = EXCLUDED.updated_at;
END;
$$;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION update_style_stock_total(TEXT) TO service_role;

-- Function to bulk refresh all style_stock_totals (for initial population or full refresh)
CREATE OR REPLACE FUNCTION refresh_all_style_stock_totals()
RETURNS TABLE(styles_updated INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_count INTEGER := 0;
  v_style_no TEXT;
BEGIN
  -- Get all distinct style_nos from style_stock
  FOR v_style_no IN 
    SELECT DISTINCT ss.style_no FROM style_stock ss
  LOOP
    PERFORM update_style_stock_total(v_style_no);
    v_count := v_count + 1;
  END LOOP;
  
  styles_updated := v_count;
  RETURN NEXT;
END;
$$;

-- Grant execute to service_role
GRANT EXECUTE ON FUNCTION refresh_all_style_stock_totals() TO service_role;
