-- Add 'Delivered' to the purchase_orders status check constraint
-- This allows POs to be marked as Delivered when they are no longer in the SPY system list

-- Drop the existing constraint
ALTER TABLE public.purchase_orders 
  DROP CONSTRAINT IF EXISTS purchase_orders_status_check;

-- Add updated constraint with 'Delivered' status
ALTER TABLE public.purchase_orders 
  ADD CONSTRAINT purchase_orders_status_check 
  CHECK (status IN ('Running', 'Shipped', 'Delivered'));

-- Add index for delivered status queries
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status_delivered 
  ON public.purchase_orders (status) 
  WHERE status = 'Delivered';

COMMENT ON COLUMN public.purchase_orders.status IS 'Running = in progress, Shipped = shipped, Delivered = no longer in SPY system (assumed delivered)';



