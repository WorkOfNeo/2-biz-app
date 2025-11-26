-- Add SPY PO number tracking for APP purchase orders

-- Add column to store the SPY system PO number
ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS spy_po_no TEXT;

-- Add index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_purchase_orders_spy_po_no 
  ON public.purchase_orders (spy_po_no);

-- Add comment
COMMENT ON COLUMN public.purchase_orders.spy_po_no IS 'The PO number assigned by the SPY system when this APP PO is pushed';

