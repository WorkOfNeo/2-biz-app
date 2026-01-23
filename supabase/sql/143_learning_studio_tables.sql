-- 143_learning_studio_tables.sql
-- Learning Studio: ai_prompt_examples, ai_learning_events, and call_off_feedback extensions

-- =============================================================================
-- 1. AI_PROMPT_EXAMPLES TABLE (examples/cases to include in prompts)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ai_prompt_examples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_key text NOT NULL, -- e.g., 'quick_po_flow_v1', 'call_off_analysis_v2'
  title text NOT NULL, -- short description
  tags jsonb DEFAULT '[]'::jsonb, -- e.g., ["style:1010191", "supplier:bell_rain", "scenario:overstocked"]
  context_snapshot jsonb, -- the input data at the time (stock levels, sales, etc.)
  expected_behavior text NOT NULL, -- what the AI should have done / should do
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_prompt_examples_prompt_key ON public.ai_prompt_examples(prompt_key);
CREATE INDEX IF NOT EXISTS idx_ai_prompt_examples_enabled ON public.ai_prompt_examples(enabled) WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_ai_prompt_examples_tags ON public.ai_prompt_examples USING gin(tags);

-- RLS
ALTER TABLE IF EXISTS public.ai_prompt_examples ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_prompt_examples' AND policyname = 'allow authenticated read ai_prompt_examples'
  ) THEN
    CREATE POLICY "allow authenticated read ai_prompt_examples"
      ON public.ai_prompt_examples FOR SELECT
      TO authenticated
      USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_prompt_examples' AND policyname = 'allow authenticated write ai_prompt_examples'
  ) THEN
    CREATE POLICY "allow authenticated write ai_prompt_examples"
      ON public.ai_prompt_examples FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- =============================================================================
-- 2. AI_LEARNING_EVENTS TABLE (append-only log of learning updates)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.ai_learning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL CHECK (event_type IN (
    'prompt_activated',
    'prompt_created',
    'example_added',
    'example_updated',
    'example_disabled',
    'multipliers_updated',
    'manual_override'
  )),
  prompt_key text, -- which prompt this relates to (nullable for multiplier updates)
  prompt_version integer, -- version number if applicable
  details jsonb NOT NULL DEFAULT '{}'::jsonb, -- event-specific data
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_learning_events_type ON public.ai_learning_events(event_type);
CREATE INDEX IF NOT EXISTS idx_ai_learning_events_prompt_key ON public.ai_learning_events(prompt_key);
CREATE INDEX IF NOT EXISTS idx_ai_learning_events_created_at ON public.ai_learning_events(created_at DESC);

-- RLS
ALTER TABLE IF EXISTS public.ai_learning_events ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_learning_events' AND policyname = 'allow authenticated read ai_learning_events'
  ) THEN
    CREATE POLICY "allow authenticated read ai_learning_events"
      ON public.ai_learning_events FOR SELECT
      TO authenticated
      USING (true);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_learning_events' AND policyname = 'allow authenticated write ai_learning_events'
  ) THEN
    CREATE POLICY "allow authenticated write ai_learning_events"
      ON public.ai_learning_events FOR ALL
      TO authenticated
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- =============================================================================
-- 3. EXTEND CALL_OFF_FEEDBACK TABLE (add flow, prompt attribution, reason_codes)
-- =============================================================================

-- Add 'flow' column to distinguish Quick PO vs NOOS Call-Off feedback
ALTER TABLE public.call_off_feedback 
  ADD COLUMN IF NOT EXISTS flow text CHECK (flow IN ('quick_po', 'call_off'));

-- Add prompt attribution columns
ALTER TABLE public.call_off_feedback 
  ADD COLUMN IF NOT EXISTS prompt_key text;

ALTER TABLE public.call_off_feedback 
  ADD COLUMN IF NOT EXISTS prompt_version integer;

-- Add reason codes for structured learning (why was this wrong?)
ALTER TABLE public.call_off_feedback 
  ADD COLUMN IF NOT EXISTS reason_codes text[] DEFAULT '{}';

-- Add context snapshot (stock levels, historical data at time of feedback)
ALTER TABLE public.call_off_feedback 
  ADD COLUMN IF NOT EXISTS context_snapshot jsonb;

-- Index for filtering by flow
CREATE INDEX IF NOT EXISTS idx_call_off_feedback_flow ON public.call_off_feedback(flow);

-- Index for prompt attribution queries
CREATE INDEX IF NOT EXISTS idx_call_off_feedback_prompt ON public.call_off_feedback(prompt_key, prompt_version);

-- =============================================================================
-- 4. BACKFILL EXISTING FEEDBACK ROWS WITH flow='quick_po'
-- =============================================================================
-- Existing feedback came from Quick PO Flow, so mark them accordingly
UPDATE public.call_off_feedback 
SET flow = 'quick_po' 
WHERE flow IS NULL;

-- Set default for new rows (will be overridden by API)
-- Note: We don't set a default here since the API should always provide it
