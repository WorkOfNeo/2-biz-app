-- Diagnostic query: Check for duplicate purchase order rows
-- Run this BEFORE the cleanup to see what will be affected

-- 1. Find rows where row_label has extra whitespace
SELECT 
  'Rows with extra whitespace' as issue_type,
  COUNT(*) as count
FROM style_stock
WHERE 
  section = 'Purchase (Running + Shipped)'
  AND row_label IS NOT NULL
  AND row_label != TRIM(row_label);

-- 2. Find potential duplicates (same PO, same scrape time, but different whitespace)
SELECT 
  'Potential duplicate groups' as issue_type,
  COUNT(DISTINCT (style_no, color, TRIM(row_label), scraped_at)) as count
FROM style_stock
WHERE 
  section = 'Purchase (Running + Shipped)'
  AND row_label IS NOT NULL
  AND (style_no, color, TRIM(row_label), scraped_at) IN (
    SELECT style_no, color, TRIM(row_label), scraped_at
    FROM style_stock
    WHERE section = 'Purchase (Running + Shipped)' AND row_label IS NOT NULL
    GROUP BY style_no, color, TRIM(row_label), scraped_at
    HAVING COUNT(*) > 1
  );

-- 3. Detailed view of duplicates (uncomment to see specific examples)
-- SELECT 
--   style_no,
--   color,
--   row_label,
--   TRIM(row_label) as trimmed,
--   LENGTH(row_label) as label_length,
--   scraped_at,
--   id,
--   (SELECT SUM(val::numeric) FROM unnest(values) as val) as total_qty
-- FROM style_stock
-- WHERE 
--   section = 'Purchase (Running + Shipped)'
--   AND row_label IS NOT NULL
--   AND (style_no, color, TRIM(row_label), scraped_at) IN (
--     SELECT style_no, color, TRIM(row_label), scraped_at
--     FROM style_stock
--     WHERE section = 'Purchase (Running + Shipped)' AND row_label IS NOT NULL
--     GROUP BY style_no, color, TRIM(row_label), scraped_at
--     HAVING COUNT(*) > 1
--   )
-- ORDER BY style_no, color, TRIM(row_label), scraped_at, LENGTH(row_label);

