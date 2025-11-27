-- Create dedicated table for APP Purchase Orders
-- Separates APP POs from SPY-scraped purchase orders

CREATE TABLE IF NOT EXISTS public.app_pos (
  id BIGSERIAL PRIMARY KEY,
  po_no TEXT NOT NULL,
  spy_po_no TEXT,
  status TEXT CHECK (status IN ('Running','Shipped')) NOT NULL DEFAULT 'Running',
  supplier TEXT,
  styles INTEGER,
  ordered INTEGER,
  shipped INTEGER,
  etd TEXT,
  eta TEXT,
  purchaser TEXT,
  po_link TEXT,
  pdf_link TEXT,
  excel_link TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (po_no)
);

-- Enable RLS
ALTER TABLE IF EXISTS public.app_pos ENABLE ROW LEVEL SECURITY;

-- Read policy for authenticated users
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_pos' AND policyname = 'allow authenticated read app_pos'
  ) THEN
    CREATE POLICY "allow authenticated read app_pos"
      ON public.app_pos FOR SELECT
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Insert policy for authenticated users
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_pos' AND policyname = 'allow authenticated insert app_pos'
  ) THEN
    CREATE POLICY "allow authenticated insert app_pos"
      ON public.app_pos FOR INSERT
      TO authenticated
      WITH CHECK (true);
  END IF;
END $$;

-- Update policy for authenticated users
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_pos' AND policyname = 'allow authenticated update app_pos'
  ) THEN
    CREATE POLICY "allow authenticated update app_pos"
      ON public.app_pos FOR UPDATE
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_app_pos_po_no ON public.app_pos (po_no);
CREATE INDEX IF NOT EXISTS idx_app_pos_spy_po_no ON public.app_pos (spy_po_no);
CREATE INDEX IF NOT EXISTS idx_app_pos_updated_at ON public.app_pos (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_pos_created_at ON public.app_pos (created_at DESC);

-- Trigger to keep updated_at current
DROP TRIGGER IF EXISTS set_timestamp_app_pos ON public.app_pos;
CREATE TRIGGER set_timestamp_app_pos
BEFORE UPDATE ON public.app_pos
FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Add comment
COMMENT ON TABLE public.app_pos IS 'APP-created purchase orders (separate from SPY-scraped POs)';

