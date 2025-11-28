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

-- Query 2: Check the specific style you mentioned (10214411452)
SELECT 
  id,
  style_no,
  color,
  section,
  row_label,
  scraped_at,
  updated_at
FROM style_stock
WHERE style_no = '10214411452'
  AND section = 'Purchase (Running + Shipped)'
ORDER BY color, row_label, scraped_at DESC;

-- Query 3: Count total rows with Purchase section
SELECT 
  COUNT(*) as total_purchase_rows,
  COUNT(DISTINCT (style_no, color, COALESCE(TRIM(row_label), ''))) as unique_combinations
FROM style_stock
WHERE section = 'Purchase (Running + Shipped)';

