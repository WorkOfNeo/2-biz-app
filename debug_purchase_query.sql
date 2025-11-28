-- Debug query to check purchase order data for a specific style
-- Replace 'YOUR_STYLE_NO' and 'YOUR_COLOR' with the problematic style

SELECT 
  style_no,
  color,
  section,
  row_label as po_number,
  values as quantities,
  scraped_at,
  -- Calculate total for each row
  (SELECT SUM(val::numeric) 
   FROM unnest(values) as val) as row_total
FROM style_stock
WHERE 
  style_no = 'YOUR_STYLE_NO' 
  AND color = 'YOUR_COLOR'
  AND section = 'Purchase (Running + Shipped)'
ORDER BY row_label, scraped_at DESC;

-- This will show you:
-- 1. Each purchase order (row_label)
-- 2. Multiple scrapes of the same PO (different scraped_at)
-- 3. The quantities in each
-- 4. The total per row
--
-- Expected behavior:
-- - For each unique row_label (PO), only the latest scraped_at should be used
-- - If you see multiple POs with the same scraped_at, they should all be summed
-- - If you see the same PO with different scraped_at, only the latest should count

