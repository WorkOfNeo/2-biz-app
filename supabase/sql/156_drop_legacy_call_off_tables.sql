-- 156_drop_legacy_call_off_tables.sql
-- Drop legacy call-off tables as they are replaced by the new NOOS Call Off flow

-- Drop policies first
DO $$ BEGIN
  DROP POLICY IF EXISTS "allow authenticated read call_off_analysis" ON public.call_off_analysis;
  DROP POLICY IF EXISTS "allow authenticated write call_off_analysis" ON public.call_off_analysis;
  DROP POLICY IF EXISTS "allow authenticated read call_off_feedback" ON public.call_off_feedback;
  DROP POLICY IF EXISTS "allow authenticated write call_off_feedback" ON public.call_off_feedback;
EXCEPTION
  WHEN undefined_table THEN NULL;
  WHEN undefined_object THEN NULL;
END $$;

-- Drop tables
DROP TABLE IF EXISTS public.call_off_feedback CASCADE;
DROP TABLE IF EXISTS public.call_off_analysis CASCADE;

-- Note: The call-off page and API routes have been removed from the codebase
-- The new NOOS Call Off flow uses the purchase/size-calculator page and noos_call_off_stock table
