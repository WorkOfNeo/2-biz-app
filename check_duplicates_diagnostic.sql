-- Diagnostic: Check if there are any duplicate PO rows in your database

-- Query 1: Count duplicates by (style_no, color, section, row_label)
SELECT 
  style_no,
  color,
  section,
  COALESCE(TRIM(row_label), '') as row_label,
  COUNT(*) as count,
  STRING_AGG(DISTINCT scraped_at::text, ', ' ORDER BY scraped_at::text DESC) as scraped_at_times,
  MIN(scraped_at) as oldest_scrape,
  MAX(scraped_at) as newest_scrape
FROM style_stock
GROUP BY style_no, color, section, COALESCE(TRIM(row_label), '')
HAVING COUNT(*) > 1
ORDER BY COUNT(*) DESC, style_no, color
LIMIT 50;

-- Query 2: Show ALL rows that are part of duplicate groups
-- This shows you every duplicate row across the entire database
WITH duplicates AS (
  SELECT 
    style_no,
    color,
    section,
    COALESCE(TRIM(row_label), '') as normalized_label
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
  s.updated_at,
  LENGTH(s.values::text) as values_size
FROM style_stock s
INNER JOIN duplicates d ON
  s.style_no = d.style_no
  AND s.color = d.color
  AND s.section = d.section
  AND COALESCE(TRIM(s.row_label), '') = d.normalized_label
ORDER BY s.style_no, s.color, s.section, s.row_label, s.scraped_at DESC
LIMIT 200;

-- Query 3: Count total rows with Purchase section
SELECT 
  COUNT(*) as total_purchase_rows,
  COUNT(DISTINCT (style_no, color, COALESCE(TRIM(row_label), ''))) as unique_combinations
FROM style_stock
WHERE section = 'Purchase (Running + Shipped)';

