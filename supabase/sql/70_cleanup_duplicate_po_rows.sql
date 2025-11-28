-- Clean up duplicate purchase order rows where row_label differs only by whitespace
-- Run 70_check_duplicates.sql FIRST to see what will be affected!

-- STEP 1: Delete exact duplicates (same PO, same time, same data, only whitespace differs)
-- Keep the version with the shortest row_label (trimmed)
WITH duplicate_groups AS (
  SELECT 
    style_no,
    color,
    section,
    TRIM(row_label) as normalized_label,
    scraped_at,
    values,
    sizes,
    MIN(LENGTH(row_label)) as min_length,
    COUNT(*) as duplicate_count
  FROM style_stock
  WHERE 
    section = 'Purchase (Running + Shipped)'
    AND row_label IS NOT NULL
  GROUP BY style_no, color, section, TRIM(row_label), scraped_at, values, sizes
  HAVING COUNT(*) > 1
),
rows_to_keep AS (
  SELECT DISTINCT ON (s.style_no, s.color, TRIM(s.row_label), s.scraped_at)
    s.id
  FROM style_stock s
  INNER JOIN duplicate_groups dg ON
    s.style_no = dg.style_no
    AND s.color = dg.color
    AND s.section = dg.section
    AND TRIM(s.row_label) = dg.normalized_label
    AND s.scraped_at = dg.scraped_at
    AND s.values = dg.values
  ORDER BY 
    s.style_no, 
    s.color, 
    TRIM(s.row_label), 
    s.scraped_at,
    LENGTH(s.row_label) ASC,  -- Keep the shortest (trimmed) version
    s.id ASC
)
DELETE FROM style_stock
WHERE 
  section = 'Purchase (Running + Shipped)'
  AND row_label IS NOT NULL
  AND (style_no, color, TRIM(row_label), scraped_at) IN (
    SELECT style_no, color, normalized_label, scraped_at 
    FROM duplicate_groups
  )
  AND id NOT IN (SELECT id FROM rows_to_keep);

-- STEP 2: Trim all remaining row_label values to prevent future duplicates
UPDATE style_stock
SET row_label = TRIM(row_label)
WHERE 
  row_label IS NOT NULL
  AND row_label != TRIM(row_label);

-- Report results
DO $$
DECLARE
  deleted_count INTEGER;
  updated_count INTEGER;
BEGIN
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  UPDATE style_stock SET row_label = TRIM(row_label)
  WHERE row_label IS NOT NULL AND row_label != TRIM(row_label);
  
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  
  RAISE NOTICE 'Cleanup complete: Deleted % duplicate rows, Trimmed % row labels', 
    COALESCE(deleted_count, 0), COALESCE(updated_count, 0);
END $$;

