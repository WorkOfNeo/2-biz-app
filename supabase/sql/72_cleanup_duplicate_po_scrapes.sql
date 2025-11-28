-- Clean up duplicate PO rows where same (style_no, color, section, row_label) 
-- has multiple entries with different scraped_at times
-- Keep only the LATEST scraped_at for each unique combination

-- Step 1: Identify duplicates (for verification before running delete)
-- Uncomment to see what will be deleted:
/*
WITH duplicates AS (
  SELECT 
    style_no,
    color,
    section,
    COALESCE(TRIM(row_label), '') as normalized_label,
    COUNT(*) as duplicate_count,
    MAX(scraped_at) as latest_scraped_at
  FROM style_stock
  GROUP BY style_no, color, section, COALESCE(TRIM(row_label), '')
  HAVING COUNT(*) > 1
)
SELECT 
  s.id,
  s.style_no,
  s.color,
  s.section,
  s.row_label,
  s.scraped_at,
  d.latest_scraped_at,
  CASE 
    WHEN s.scraped_at = d.latest_scraped_at THEN 'KEEP'
    ELSE 'DELETE'
  END as action
FROM style_stock s
INNER JOIN duplicates d ON
  s.style_no = d.style_no
  AND s.color = d.color
  AND s.section = d.section
  AND COALESCE(TRIM(s.row_label), '') = d.normalized_label
ORDER BY s.style_no, s.color, s.section, s.row_label, s.scraped_at DESC;
*/

-- Step 2: Delete old duplicate rows, keeping only the latest scraped_at
WITH duplicates AS (
  SELECT 
    style_no,
    color,
    section,
    COALESCE(TRIM(row_label), '') as normalized_label,
    MAX(scraped_at) as latest_scraped_at
  FROM style_stock
  GROUP BY style_no, color, section, COALESCE(TRIM(row_label), '')
  HAVING COUNT(*) > 1
),
rows_to_keep AS (
  -- For each duplicate group, select the id of the row with latest scraped_at
  SELECT DISTINCT ON (s.style_no, s.color, s.section, COALESCE(TRIM(s.row_label), ''))
    s.id
  FROM style_stock s
  INNER JOIN duplicates d ON
    s.style_no = d.style_no
    AND s.color = d.color
    AND s.section = d.section
    AND COALESCE(TRIM(s.row_label), '') = d.normalized_label
    AND s.scraped_at = d.latest_scraped_at
  ORDER BY 
    s.style_no, 
    s.color, 
    s.section, 
    COALESCE(TRIM(s.row_label), ''),
    s.id ASC  -- If multiple rows have same latest timestamp, keep first by id
)
DELETE FROM style_stock
WHERE id IN (
  -- Select all rows that are duplicates but NOT in the rows_to_keep list
  SELECT s.id
  FROM style_stock s
  INNER JOIN duplicates d ON
    s.style_no = d.style_no
    AND s.color = d.color
    AND s.section = d.section
    AND COALESCE(TRIM(s.row_label), '') = d.normalized_label
  WHERE s.id NOT IN (SELECT id FROM rows_to_keep)
);

-- Step 3: Report results
DO $$
DECLARE
  deleted_count INTEGER;
  remaining_count INTEGER;
BEGIN
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  SELECT COUNT(*) INTO remaining_count FROM style_stock;
  
  RAISE NOTICE 'Cleanup complete:';
  RAISE NOTICE '- Deleted % duplicate rows', deleted_count;
  RAISE NOTICE '- Remaining rows: %', remaining_count;
  RAISE NOTICE 'For each (style_no, color, section, row_label) combination, kept only the most recent scraped_at';
END $$;

