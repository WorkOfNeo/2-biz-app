-- 103_ai_prompts_and_runs.sql
-- Centralized AI prompt registry and run audit tables for purchasing AI

-- =============================================================================
-- 1. AI_PROMPTS TABLE (versioned prompt registry)
-- =============================================================================
create table if not exists public.ai_prompts (
  id uuid primary key default gen_random_uuid(),
  key text not null, -- e.g., 'purchase_suggestions_v1', 'call_off_analysis'
  version integer not null default 1,
  content text not null, -- the prompt template with placeholders
  schema jsonb, -- expected input/output schema documentation
  model text not null default 'gpt-4o-mini',
  temperature numeric(3,2) default 0.3,
  max_tokens integer default 4000,
  active boolean not null default false,
  notes text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only one active prompt per key
create unique index if not exists uq_ai_prompts_key_version on public.ai_prompts(key, version);
create unique index if not exists uq_ai_prompts_key_active on public.ai_prompts(key) where active = true;
create index if not exists idx_ai_prompts_key on public.ai_prompts(key);

-- RLS
alter table if exists public.ai_prompts enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_prompts' and policyname = 'allow authenticated read ai_prompts'
  ) then
    create policy "allow authenticated read ai_prompts"
      on public.ai_prompts for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_prompts' and policyname = 'allow authenticated write ai_prompts'
  ) then
    create policy "allow authenticated write ai_prompts"
      on public.ai_prompts for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 2. AI_RUNS TABLE (audit log for all AI calls)
-- =============================================================================
create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  -- Prompt reference (store both ID and the actual content used for audit)
  prompt_id uuid references public.ai_prompts(id) on delete set null,
  prompt_key text not null,
  prompt_version integer,
  prompt_content text not null, -- exact prompt text used (for reproducibility)
  -- Model configuration
  model text not null,
  temperature numeric(3,2),
  max_tokens integer,
  -- Input/Output
  input_snapshot jsonb not null, -- aggregated data sent to AI
  output jsonb, -- parsed AI response
  raw_response text, -- raw text response from API
  -- Usage tracking (for cost monitoring)
  usage jsonb, -- {prompt_tokens, completion_tokens, total_tokens}
  -- Status
  status text not null check (status in ('pending', 'running', 'completed', 'failed')) default 'pending',
  error text,
  duration_ms integer, -- time taken for the API call
  -- Metadata
  created_by uuid,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_ai_runs_prompt_key on public.ai_runs(prompt_key);
create index if not exists idx_ai_runs_status on public.ai_runs(status);
create index if not exists idx_ai_runs_created_at on public.ai_runs(created_at desc);

-- RLS
alter table if exists public.ai_runs enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_runs' and policyname = 'allow authenticated read ai_runs'
  ) then
    create policy "allow authenticated read ai_runs"
      on public.ai_runs for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'ai_runs' and policyname = 'allow authenticated write ai_runs'
  ) then
    create policy "allow authenticated write ai_runs"
      on public.ai_runs for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 3. PURCHASE_AI_RUNS TABLE (purchase-specific metadata + feedback)
-- =============================================================================
create table if not exists public.purchase_ai_runs (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid not null references public.ai_runs(id) on delete cascade,
  -- Context
  season_id uuid,
  import_id uuid, -- references purchase_sales_imports (created in next migration)
  date_range jsonb, -- {start, end}
  -- Outcomes
  created_app_po_ids bigint[] default '{}', -- IDs of draft app_pos created
  supplier_suggestions jsonb, -- parsed suggestions by supplier
  -- User feedback loop
  user_feedback jsonb default '{}', -- {supplier_id: {verdict, adjustments, notes}}
  feedback_summary text, -- AI-generated summary of feedback for future prompts
  -- Status
  status text not null check (status in ('pending', 'reviewing', 'completed', 'cancelled')) default 'pending',
  -- Metadata
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_purchase_ai_runs_ai_run_id on public.purchase_ai_runs(ai_run_id);
create index if not exists idx_purchase_ai_runs_season_id on public.purchase_ai_runs(season_id);
create index if not exists idx_purchase_ai_runs_status on public.purchase_ai_runs(status);
create index if not exists idx_purchase_ai_runs_created_at on public.purchase_ai_runs(created_at desc);

-- RLS
alter table if exists public.purchase_ai_runs enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_ai_runs' and policyname = 'allow authenticated read purchase_ai_runs'
  ) then
    create policy "allow authenticated read purchase_ai_runs"
      on public.purchase_ai_runs for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_ai_runs' and policyname = 'allow authenticated write purchase_ai_runs'
  ) then
    create policy "allow authenticated write purchase_ai_runs"
      on public.purchase_ai_runs for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 4. TRIGGERS FOR UPDATED_AT
-- =============================================================================
drop trigger if exists set_timestamp_ai_prompts on public.ai_prompts;
create trigger set_timestamp_ai_prompts
before update on public.ai_prompts
for each row execute procedure public.set_updated_at();

drop trigger if exists set_timestamp_purchase_ai_runs on public.purchase_ai_runs;
create trigger set_timestamp_purchase_ai_runs
before update on public.purchase_ai_runs
for each row execute procedure public.set_updated_at();

-- =============================================================================
-- 5. SEED: Default purchase suggestions prompt
-- =============================================================================
insert into public.ai_prompts (key, version, content, schema, model, temperature, max_tokens, active, notes)
values (
  'purchase_suggestions_v1',
  1,
  E'You are a purchasing advisor for a fashion wholesale company. Analyze the in-season sales data and produce structured purchase order suggestions grouped by supplier.\n\n## Context\n{{context}}\n\n## Supplier Master Data\n{{suppliers}}\n\n## Sales Summary by Supplier\n{{sales_by_supplier}}\n\n## Customer Coverage Analysis\n{{customer_analysis}}\n\n## Year-over-Year Comparison (vs Last Season)\n{{yoy_analysis}}\n\n## Previous Feedback (Learning from past runs)\n{{feedback}}\n\n## Instructions\nConsider the YoY analysis when making recommendations:\n- If aggregated index is below 100%, be more conservative with order quantities\n- Factor in nulled customers (lost potential) when projecting total demand\n- Consider remaining potential from customers not yet visited\n1. For each supplier, recommend which styles/colors to order and in what quantities.\n2. Consider MOQ (minimum order quantity) and lead times.\n3. Factor in sales velocity, customer coverage, and year-over-year indices.\n4. Output MUST be valid JSON matching the schema.\n\n## Output Schema\n```json\n{\n  "suppliers": [\n    {\n      "supplier_name": "string",\n      "supplier_id": "uuid",\n      "recommendation_summary": "string (2-3 sentences)",\n      "total_units": number,\n      "total_value_estimate": number,\n      "lines": [\n        {\n          "style_no": "string",\n          "color": "string",\n          "suggested_qty": number,\n          "reasoning": "string (1 sentence)",\n          "priority": "high" | "medium" | "low"\n        }\n      ],\n      "moq_status": "met" | "under" | "n/a",\n      "notes": "string (optional)"\n    }\n  ],\n  "overall_summary": "string (3-4 sentences)",\n  "total_units": number,\n  "warnings": ["string"]\n}\n```',
  '{
    "input": {
      "context": "Season info, date range, analysis parameters",
      "suppliers": "Array of supplier master data with MOQ, lead times",
      "sales_by_supplier": "Aggregated sales grouped by supplier/style/color",
      "customer_analysis": "Customer visit coverage, YoY indices"
    },
    "output": {
      "suppliers": "Array of supplier recommendations with line items",
      "overall_summary": "Executive summary",
      "total_units": "Total suggested units across all suppliers",
      "warnings": "Any alerts or concerns"
    }
  }'::jsonb,
  'gpt-4o-mini',
  0.3,
  4000,
  true,
  'Initial purchase suggestions prompt - v1'
)
on conflict (key, version) do nothing;

