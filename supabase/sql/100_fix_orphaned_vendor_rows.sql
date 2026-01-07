-- 100_fix_orphaned_vendor_rows.sql
-- Reset cached values for vendor_rows that have no actual styles

-- Reset antal_prøver, styles_i_koll etc to 0 for vendors with no styles
UPDATE public.vendor_rows vr
SET 
  antal_prøver = 0,
  styles_i_koll = 0,
  gns_pris_pr_prøve = 0,
  total = 0,
  total_ubrugte = 0,
  diff = 0,
  prøvefaktor = 0
WHERE NOT EXISTS (
  SELECT 1 FROM public.vendor_styles vs 
  WHERE vs.vendor_row_id = vr.id
)
AND (vr.antal_prøver > 0 OR vr.styles_i_koll > 0);

-- Show how many rows were affected
DO $$
DECLARE
  affected_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO affected_count
  FROM public.vendor_rows vr
  WHERE NOT EXISTS (
    SELECT 1 FROM public.vendor_styles vs 
    WHERE vs.vendor_row_id = vr.id
  )
  AND (vr.antal_prøver = 0 AND vr.styles_i_koll = 0);
  
  RAISE NOTICE 'Vendor rows with stale data have been reset. Current count of rows without styles: %', affected_count;
END $$;





