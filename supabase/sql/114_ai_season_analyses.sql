-- 114_ai_season_analyses.sql
-- Stores daily AI analyses and purchase round results for season monitoring

create table if not exists public.ai_season_analyses (
  id uuid primary key default gen_random_uuid(),
  ai_run_id uuid references public.ai_runs(id) on delete set null,
  season_id uuid not null references public.seasons(id) on delete cascade,
  comparison_season_id uuid references public.seasons(id) on delete set null,
  analysis_type text not null check (analysis_type in ('daily', 'purchase_round')),
  analysis_date date not null,
  
  -- Snapshot metrics at time of analysis
  metrics jsonb not null default '{}'::jsonb,
  -- Expected structure:
  -- {
  --   total_qty, total_revenue, unique_customers, unique_styles,
  --   customer_coverage: { total, visited, visit_rate_percent, nulled },
  --   velocity: { avg_daily_qty, avg_daily_revenue, projected_total },
  --   by_salesperson: [...],
  --   by_country: [...],
  --   top_styles: [...]
  -- }
  
  -- AI generated content
  executive_summary text,
  salesperson_reports jsonb default '{}'::jsonb,
  -- { salesperson_id: { name, status, summary, performance_score, recommendations } }
  
  style_insights jsonb default '{}'::jsonb,
  -- { hot_styles: [], concerns: [], watch_list: [] }
  
  warnings text[] default '{}',
  recommendations text[] default '{}',
  comparison_note text,
  
  -- Purchase round specific (null for daily analyses)
  purchase_round_number integer,
  purchase_recommendations jsonb,
  -- { suppliers: [{ supplier_name, lines: [...], total_units, ... }] }
  
  -- Notification tracking
  email_sent_at timestamptz,
  email_recipients text[] default '{}',
  
  -- Metadata
  created_by uuid,
  created_at timestamptz not null default now()
);

-- Indexes
create index if not exists idx_ai_season_analyses_season on public.ai_season_analyses(season_id);
create index if not exists idx_ai_season_analyses_type on public.ai_season_analyses(analysis_type);
create index if not exists idx_ai_season_analyses_date on public.ai_season_analyses(analysis_date desc);
create index if not exists idx_ai_season_analyses_created on public.ai_season_analyses(created_at desc);

-- RLS
alter table public.ai_season_analyses enable row level security;

drop policy if exists ai_season_analyses_select_all on public.ai_season_analyses;
create policy ai_season_analyses_select_all on public.ai_season_analyses 
  for select to public using (true);

drop policy if exists ai_season_analyses_insert_authenticated on public.ai_season_analyses;
create policy ai_season_analyses_insert_authenticated on public.ai_season_analyses 
  for insert to authenticated with check (true);

drop policy if exists ai_season_analyses_update_authenticated on public.ai_season_analyses;
create policy ai_season_analyses_update_authenticated on public.ai_season_analyses 
  for update to authenticated using (true) with check (true);

drop policy if exists ai_season_analyses_delete_authenticated on public.ai_season_analyses;
create policy ai_season_analyses_delete_authenticated on public.ai_season_analyses 
  for delete to authenticated using (true);
