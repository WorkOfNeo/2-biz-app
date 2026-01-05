-- 107_purchase_run_snapshots.sql
-- Extend purchase_ai_runs for run labeling, feature snapshots, and line-level feedback

-- =============================================================================
-- 1. EXTEND PURCHASE_AI_RUNS TABLE
-- =============================================================================

-- Add run labeling and comparison fields
alter table if exists public.purchase_ai_runs
  add column if not exists run_label text, -- e.g., 'Round_1', 'Week_03'
  add column if not exists run_number integer, -- sequential run number per season
  add column if not exists comparison_mode text default 'csv_to_season_totals', -- e.g., 'csv_to_season_totals'
  add column if not exists comparison_season_id uuid, -- reference to the comparison season
  add column if not exists computed_features_snapshot jsonb default '{}', -- exact comparison aggregates used
  add column if not exists run_started_at timestamptz,
  add column if not exists run_completed_at timestamptz;

-- Add index for efficient querying
create index if not exists idx_purchase_ai_runs_run_label on public.purchase_ai_runs(run_label);
create index if not exists idx_purchase_ai_runs_run_number on public.purchase_ai_runs(run_number);
create index if not exists idx_purchase_ai_runs_comparison_season on public.purchase_ai_runs(comparison_season_id);

-- =============================================================================
-- 2. PURCHASE_AI_LINE_FEEDBACK TABLE (line-level feedback)
-- =============================================================================
create table if not exists public.purchase_ai_line_feedback (
  id uuid primary key default gen_random_uuid(),
  purchase_run_id uuid not null references public.purchase_ai_runs(id) on delete cascade,
  -- Line identification
  supplier_name text not null,
  style_no text not null,
  color text not null,
  -- AI suggestion
  suggested_qty integer not null default 0,
  -- User adjustment
  adjusted_qty integer, -- null if not adjusted
  -- Feedback
  verdict text check (verdict in ('approved', 'adjusted', 'skipped', 'added')) default 'approved',
  reason text, -- user's reason for adjustment
  priority text check (priority in ('high', 'medium', 'low')) default 'medium',
  -- Metadata
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_purchase_ai_line_feedback_run on public.purchase_ai_line_feedback(purchase_run_id);
create index if not exists idx_purchase_ai_line_feedback_style on public.purchase_ai_line_feedback(style_no, color);
create index if not exists idx_purchase_ai_line_feedback_supplier on public.purchase_ai_line_feedback(supplier_name);

-- RLS
alter table if exists public.purchase_ai_line_feedback enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_ai_line_feedback' and policyname = 'allow authenticated read purchase_ai_line_feedback'
  ) then
    create policy "allow authenticated read purchase_ai_line_feedback"
      on public.purchase_ai_line_feedback for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_ai_line_feedback' and policyname = 'allow authenticated write purchase_ai_line_feedback'
  ) then
    create policy "allow authenticated write purchase_ai_line_feedback"
      on public.purchase_ai_line_feedback for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- Trigger for updated_at
drop trigger if exists set_timestamp_purchase_ai_line_feedback on public.purchase_ai_line_feedback;
create trigger set_timestamp_purchase_ai_line_feedback
before update on public.purchase_ai_line_feedback
for each row execute procedure public.set_updated_at();

-- =============================================================================
-- 3. VIEW: Aggregated feedback for learning
-- =============================================================================
create or replace view public.purchase_ai_feedback_summary as
select
  palf.purchase_run_id,
  par.season_id,
  par.comparison_season_id,
  palf.supplier_name,
  palf.style_no,
  palf.color,
  palf.suggested_qty,
  palf.adjusted_qty,
  coalesce(palf.adjusted_qty, palf.suggested_qty) as final_qty,
  palf.verdict,
  palf.reason,
  case 
    when palf.adjusted_qty is null then 0
    else palf.adjusted_qty - palf.suggested_qty 
  end as adjustment_delta,
  case 
    when palf.adjusted_qty is null or palf.suggested_qty = 0 then 0
    else round(((palf.adjusted_qty - palf.suggested_qty)::numeric / palf.suggested_qty) * 100, 1)
  end as adjustment_percent,
  par.run_label,
  par.run_number,
  par.created_at as run_created_at
from public.purchase_ai_line_feedback palf
join public.purchase_ai_runs par on par.id = palf.purchase_run_id;

-- =============================================================================
-- 4. FUNCTION: Get next run number for a season
-- =============================================================================
create or replace function public.get_next_purchase_run_number(p_season_id uuid)
returns integer as $$
declare
  v_next integer;
begin
  select coalesce(max(run_number), 0) + 1 into v_next
  from public.purchase_ai_runs
  where season_id = p_season_id;
  return v_next;
end;
$$ language plpgsql;

-- =============================================================================
-- 5. FUNCTION: Get recent feedback for AI learning (last 5 runs)
-- =============================================================================
create or replace function public.get_recent_line_feedback(p_season_id uuid, p_limit integer default 100)
returns table (
  supplier_name text,
  style_no text,
  color text,
  suggested_qty integer,
  adjusted_qty integer,
  verdict text,
  reason text,
  run_label text,
  run_number integer
) as $$
begin
  return query
  select 
    palf.supplier_name,
    palf.style_no,
    palf.color,
    palf.suggested_qty,
    palf.adjusted_qty,
    palf.verdict,
    palf.reason,
    par.run_label,
    par.run_number
  from public.purchase_ai_line_feedback palf
  join public.purchase_ai_runs par on par.id = palf.purchase_run_id
  where par.season_id = p_season_id
    and palf.verdict in ('adjusted', 'skipped') -- Only include non-approved for learning
  order by par.created_at desc
  limit p_limit;
end;
$$ language plpgsql;

