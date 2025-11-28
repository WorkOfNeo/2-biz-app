-- Add confirmed status column to app_pos table

ALTER TABLE public.app_pos
  ADD COLUMN IF NOT EXISTS confirmed BOOLEAN NOT NULL DEFAULT false;

-- Add index for filtering confirmed orders
CREATE INDEX IF NOT EXISTS idx_app_pos_confirmed 
  ON public.app_pos (confirmed, created_at DESC);

-- Add comment
COMMENT ON COLUMN public.app_pos.confirmed IS 'Whether this APP PO has been confirmed by the user';

