-- Normalize row_label values to ensure upsert works correctly
-- This fixes the issue where PO updates were creating new rows instead of replacing existing ones

-- Step 1: Trim all row_label values and convert NULL to empty string
UPDATE style_stock
SET row_label = TRIM(COALESCE(row_label, ''))
WHERE 
  row_label IS NULL 
  OR row_label != TRIM(row_label);

-- Step 2: Find and merge duplicate rows that differ only by whitespace
-- (This handles historical data where whitespace variations created duplicates)
WITH duplicates AS (
  SELECT 
    style_no,
    color,
    section,
    TRIM(COALESCE(row_label, '')) as normalized_label,
    MAX(scraped_at) as latest_scraped
  FROM style_stock
  GROUP BY style_no, color, section, TRIM(COALESCE(row_label, ''))
  HAVING COUNT(*) > 1
),
rows_to_keep AS (
  SELECT DISTINCT ON (s.style_no, s.color, s.section, TRIM(COALESCE(s.row_label, '')))
    s.id
  FROM style_stock s
  INNER JOIN duplicates d ON
    s.style_no = d.style_no
    AND s.color = d.color
    AND s.section = d.section
    AND TRIM(COALESCE(s.row_label, '')) = d.normalized_label
  ORDER BY 
    s.style_no, 
    s.color, 
    s.section,
    TRIM(COALESCE(s.row_label, '')),
    s.scraped_at DESC,  -- Keep the most recent
    s.id ASC
)
DELETE FROM style_stock
WHERE id IN (
  SELECT s.id
  FROM style_stock s
  INNER JOIN duplicates d ON
    s.style_no = d.style_no
    AND s.color = d.color
    AND s.section = d.section
    AND TRIM(COALESCE(s.row_label, '')) = d.normalized_label
  WHERE s.id NOT IN (SELECT id FROM rows_to_keep)
);

-- Step 3: Add a constraint to ensure row_label is never NULL (always empty string instead)
ALTER TABLE style_stock 
  ALTER COLUMN row_label SET DEFAULT '';

-- Update any remaining NULL values
UPDATE style_stock SET row_label = '' WHERE row_label IS NULL;

-- Add NOT NULL constraint
ALTER TABLE style_stock 
  ALTER COLUMN row_label SET NOT NULL;

-- Report
DO $$
DECLARE
  row_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO row_count FROM style_stock;
  RAISE NOTICE 'Normalization complete. Total rows: %', row_count;
END $$;

