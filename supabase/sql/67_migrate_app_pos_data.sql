-- Migrate existing APP POs from purchase_orders to app_pos table

-- Insert APP POs (category='app') from purchase_orders into app_pos
INSERT INTO public.app_pos (
  po_no,
  spy_po_no,
  status,
  supplier,
  styles,
  ordered,
  shipped,
  etd,
  eta,
  purchaser,
  po_link,
  pdf_link,
  excel_link,
  meta,
  created_at,
  updated_at
)
SELECT 
  po_no,
  spy_po_no,
  status,
  supplier,
  styles,
  ordered,
  shipped,
  etd,
  eta,
  purchaser,
  po_link,
  pdf_link,
  excel_link,
  meta,
  created_at,
  updated_at
FROM public.purchase_orders
WHERE category = 'app'
ON CONFLICT (po_no) DO NOTHING;

-- Log the migration
DO $$
DECLARE
  migrated_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO migrated_count FROM public.app_pos;
  RAISE NOTICE 'Migrated % APP POs to app_pos table', migrated_count;
END $$;

