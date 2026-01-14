-- 125_purchase_ai_runs_extend.sql
-- Extend purchase_ai_runs with purchase stage and prompt metadata

-- Add FK reference from season_id to seasons (for Supabase joins)
-- First check if the FK already exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE constraint_name = 'purchase_ai_runs_season_id_fkey'
    AND table_name = 'purchase_ai_runs'
  ) THEN
    ALTER TABLE public.purchase_ai_runs
      ADD CONSTRAINT purchase_ai_runs_season_id_fkey 
      FOREIGN KEY (season_id) REFERENCES public.seasons(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Add purchase stage tracking
ALTER TABLE public.purchase_ai_runs
  ADD COLUMN IF NOT EXISTS purchase_stage text 
    CHECK (purchase_stage IS NULL OR purchase_stage IN ('early', 'mid', 'closing'));

-- Add prompt metadata (for when ai_run_id might not be set yet or for quick access)
ALTER TABLE public.purchase_ai_runs
  ADD COLUMN IF NOT EXISTS prompt_key text,
  ADD COLUMN IF NOT EXISTS prompt_version integer,
  ADD COLUMN IF NOT EXISTS model text;

-- Index for stage-based queries
CREATE INDEX IF NOT EXISTS idx_purchase_ai_runs_stage ON public.purchase_ai_runs(purchase_stage);

-- Comment
COMMENT ON COLUMN public.purchase_ai_runs.purchase_stage IS 
  'early (<40% visit rate), mid (40-75%), closing (>75%) - affects purchasing strategy';
COMMENT ON COLUMN public.purchase_ai_runs.prompt_key IS 'AI prompt key used for this run';
COMMENT ON COLUMN public.purchase_ai_runs.prompt_version IS 'AI prompt version used for this run';
COMMENT ON COLUMN public.purchase_ai_runs.model IS 'OpenAI model used for this run';
