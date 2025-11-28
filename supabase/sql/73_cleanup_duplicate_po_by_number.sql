-- Clean up duplicate PO rows where the same PO NUMBER appears with different ETAs
-- Example: "PO7312 ETA 2025-12-03" and "PO7312 ETA 2025-12-08" are the SAME PO
-- Keep only the LATEST scraped_at for each unique PO number

-- Step 1: Preview what will be cleaned (uncomment to check before deleting)
/*
WITH po_extracted AS (
  SELECT 
    id,
    style_no,
    color,
    section,
    row_label,
    scraped_at,
    -- Extract PO number from row_label (e.g., "PO7312" from "PO7312 ETA 2025-12-03")
    CASE 
      WHEN row_label ~ '^PO[0-9]+ ETA' THEN 
        (regexp_match(row_label, '^(PO[0-9]+)'))[1]
      ELSE 
        COALESCE(TRIM(row_label), '')
    END as po_number
  FROM style_stock
  WHERE section = 'Purchase (Running + Shipped)'
),
duplicates AS (
  SELECT 
    style_no,
    color,
    section,
    po_number,
    COUNT(*) as duplicate_count,
    MAX(scraped_at) as latest_scraped_at
  FROM po_extracted
  GROUP BY style_no, color, section, po_number
  HAVING COUNT(*) > 1
)
SELECT 
  pe.id,
  pe.style_no,
  pe.color,
  pe.po_number,
  pe.row_label,
  pe.scraped_at,
  d.latest_scraped_at,
  d.duplicate_count,
  CASE 
    WHEN pe.scraped_at = d.latest_scraped_at THEN 'KEEP ✓'
    ELSE 'DELETE ✗'
  END as action
FROM po_extracted pe
INNER JOIN duplicates d ON
  pe.style_no = d.style_no
  AND pe.color = d.color
  AND pe.section = d.section
  AND pe.po_number = d.po_number
ORDER BY pe.style_no, pe.color, pe.po_number, pe.scraped_at DESC;
*/

-- Step 2: Delete old versions of the same PO, keeping only the latest
WITH po_extracted AS (
  SELECT 
    id,
    style_no,
    color,
    section,
    scraped_at,
    -- Extract PO number from row_label (e.g., "PO7312" from "PO7312 ETA 2025-12-03")
    CASE 
      WHEN row_label ~ '^PO[0-9]+ ETA' THEN 
        (regexp_match(row_label, '^(PO[0-9]+)'))[1]
      ELSE 
        COALESCE(TRIM(row_label), '')
    END as po_number
  FROM style_stock
  WHERE section = 'Purchase (Running + Shipped)'
),
duplicates AS (
  SELECT 
    style_no,
    color,
    section,
    po_number,
    MAX(scraped_at) as latest_scraped_at
  FROM po_extracted
  GROUP BY style_no, color, section, po_number
  HAVING COUNT(*) > 1
),
rows_to_keep AS (
  -- For each duplicate group, select the id of the row with latest scraped_at
  SELECT DISTINCT ON (pe.style_no, pe.color, pe.section, pe.po_number)
    pe.id
  FROM po_extracted pe
  INNER JOIN duplicates d ON
    pe.style_no = d.style_no
    AND pe.color = d.color
    AND pe.section = d.section
    AND pe.po_number = d.po_number
    AND pe.scraped_at = d.latest_scraped_at
  ORDER BY 
    pe.style_no, 
    pe.color, 
    pe.section, 
    pe.po_number,
    pe.id ASC  -- If multiple rows have same latest timestamp, keep first by id
)
DELETE FROM style_stock
WHERE id IN (
  -- Select all rows that are purchase duplicates but NOT in the rows_to_keep list
  SELECT pe.id
  FROM po_extracted pe
  INNER JOIN duplicates d ON
    pe.style_no = d.style_no
    AND pe.color = d.color
    AND pe.section = d.section
    AND pe.po_number = d.po_number
  WHERE pe.id NOT IN (SELECT id FROM rows_to_keep)
);

-- Step 3: Report results
DO $$
DECLARE
  deleted_count INTEGER;
BEGIN
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RAISE NOTICE 'Cleanup complete:';
  RAISE NOTICE '- Deleted % duplicate PO rows (same PO number, different ETA)', deleted_count;
  RAISE NOTICE 'For each (style_no, color, PO number) combination, kept only the most recent scraped_at';
  RAISE NOTICE 'Example: "PO7312 ETA 2025-12-03" and "PO7312 ETA 2025-12-08" → kept latest';
END $$;

