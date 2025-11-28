-- Diagnostic: Check for duplicate PO NUMBERS (ignoring ETA dates)
-- Example: "PO7312 ETA 2025-12-03" and "PO7312 ETA 2025-12-08" are treated as the same PO

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
)
SELECT 
  style_no,
  color,
  po_number,
  COUNT(*) as duplicate_count,
  STRING_AGG(DISTINCT row_label, ' | ' ORDER BY row_label) as all_versions,
  MIN(scraped_at) as oldest_scrape,
  MAX(scraped_at) as newest_scrape
FROM po_extracted
GROUP BY style_no, color, section, po_number
HAVING COUNT(*) > 1
ORDER BY duplicate_count DESC, style_no, color
LIMIT 100;

-- Show detailed rows for duplicates
WITH po_extracted AS (
  SELECT 
    id,
    style_no,
    color,
    section,
    row_label,
    scraped_at,
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
    po_number
  FROM po_extracted
  GROUP BY style_no, color, section, po_number
  HAVING COUNT(*) > 1
)
SELECT 
  pe.id,
  pe.style_no,
  pe.color,
  pe.po_number,
  pe.row_label as full_label_with_eta,
  pe.scraped_at
FROM po_extracted pe
INNER JOIN duplicates d ON
  pe.style_no = d.style_no
  AND pe.color = d.color
  AND pe.section = d.section
  AND pe.po_number = d.po_number
ORDER BY pe.style_no, pe.color, pe.po_number, pe.scraped_at DESC
LIMIT 200;

