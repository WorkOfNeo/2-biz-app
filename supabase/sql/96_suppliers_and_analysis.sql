-- 96_suppliers_and_analysis.sql
-- Suppliers, rules, NOOS flag, and analysis/feedback tables for AI purchasing

-- =============================================================================
-- 1. SUPPLIERS TABLE
-- =============================================================================
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  external_name text, -- matches supplier name from other databases
  spy_id text, -- SPY system ID, manually entered
  lead_time_days integer default 0,
  travel_time_days integer default 0,
  moq integer default 0, -- minimum order quantity
  tags text[] default '{}', -- e.g., ['BELL_RAIN'] for pull-first suppliers
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_suppliers_name on public.suppliers(name);
create index if not exists idx_suppliers_active on public.suppliers(active) where active = true;

-- RLS
alter table if exists public.suppliers enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'suppliers' and policyname = 'allow authenticated read suppliers'
  ) then
    create policy "allow authenticated read suppliers"
      on public.suppliers for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'suppliers' and policyname = 'allow authenticated write suppliers'
  ) then
    create policy "allow authenticated write suppliers"
      on public.suppliers for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 2. SUPPLIER RULES TABLE (extensible rules engine)
-- =============================================================================
create table if not exists public.supplier_rules (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id) on delete cascade,
  rule_name text not null,
  rule_type text not null, -- e.g., 'moq_check', 'lead_time_buffer', 'pull_first', 'seasonality_uplift'
  params jsonb default '{}', -- flexible parameters for the rule
  priority integer default 0, -- higher priority rules evaluated first
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_supplier_rules_supplier_id on public.supplier_rules(supplier_id);
create index if not exists idx_supplier_rules_active on public.supplier_rules(active) where active = true;

-- RLS
alter table if exists public.supplier_rules enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_rules' and policyname = 'allow authenticated read supplier_rules'
  ) then
    create policy "allow authenticated read supplier_rules"
      on public.supplier_rules for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'supplier_rules' and policyname = 'allow authenticated write supplier_rules'
  ) then
    create policy "allow authenticated write supplier_rules"
      on public.supplier_rules for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 3. NOOS FLAG ON STYLE_COLORS
-- =============================================================================
alter table if exists public.style_colors
  add column if not exists is_noos boolean not null default false;

create index if not exists idx_style_colors_is_noos on public.style_colors(is_noos) where is_noos = true;

-- =============================================================================
-- 4. CALL-OFF ANALYSIS TABLE (persisted AI analyses)
-- =============================================================================
create table if not exists public.call_off_analysis (
  id uuid primary key default gen_random_uuid(),
  -- Selection criteria
  selections jsonb not null, -- [{style_no, color}, ...]
  date_range_start date not null,
  date_range_end date not null,
  weeks_cover integer not null default 4,
  -- Results
  items jsonb not null, -- full item analysis array
  orders_by_style jsonb, -- grouped order suggestions
  summary jsonb not null, -- totalItems, criticalItems, etc.
  ai_summary text, -- AI-generated markdown summary
  -- Supplier context snapshot
  supplier_rules_snapshot jsonb,
  -- Metadata
  pdf_url text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_call_off_analysis_created_at on public.call_off_analysis(created_at desc);
create index if not exists idx_call_off_analysis_date_range on public.call_off_analysis(date_range_start, date_range_end);

-- RLS
alter table if exists public.call_off_analysis enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'call_off_analysis' and policyname = 'allow authenticated read call_off_analysis'
  ) then
    create policy "allow authenticated read call_off_analysis"
      on public.call_off_analysis for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'call_off_analysis' and policyname = 'allow authenticated write call_off_analysis'
  ) then
    create policy "allow authenticated write call_off_analysis"
      on public.call_off_analysis for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 5. CALL-OFF FEEDBACK TABLE (learning from corrections)
-- =============================================================================
create table if not exists public.call_off_feedback (
  id uuid primary key default gen_random_uuid(),
  analysis_id uuid references public.call_off_analysis(id) on delete set null,
  style_no text not null,
  color text not null,
  -- Feedback
  verdict text not null check (verdict in ('correct', 'incorrect')),
  notes text,
  -- What was suggested vs what was actually ordered
  suggested_order jsonb, -- per-size suggestions
  actual_order jsonb, -- what user actually ordered
  -- Metadata
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_call_off_feedback_style_color on public.call_off_feedback(style_no, color);
create index if not exists idx_call_off_feedback_created_at on public.call_off_feedback(created_at desc);
create index if not exists idx_call_off_feedback_verdict on public.call_off_feedback(verdict);

-- RLS
alter table if exists public.call_off_feedback enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'call_off_feedback' and policyname = 'allow authenticated read call_off_feedback'
  ) then
    create policy "allow authenticated read call_off_feedback"
      on public.call_off_feedback for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'call_off_feedback' and policyname = 'allow authenticated write call_off_feedback'
  ) then
    create policy "allow authenticated write call_off_feedback"
      on public.call_off_feedback for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 6. SEASONAL ANALYSIS TABLE (for seasonal purchasing AI)
-- =============================================================================
create table if not exists public.seasonal_analysis (
  id uuid primary key default gen_random_uuid(),
  -- Selection criteria
  season_id uuid,
  selections jsonb not null, -- [{style_no, color, supplier}, ...]
  date_range_start date not null,
  date_range_end date not null,
  -- Results
  items jsonb not null, -- full item analysis with country breakdown
  orders_by_style jsonb,
  orders_by_country jsonb, -- country-level breakdown
  summary jsonb not null,
  ai_summary text,
  -- Supplier context snapshot
  supplier_rules_snapshot jsonb,
  -- Metadata
  pdf_url text,
  created_by uuid,
  created_at timestamptz not null default now()
);

create index if not exists idx_seasonal_analysis_created_at on public.seasonal_analysis(created_at desc);
create index if not exists idx_seasonal_analysis_season_id on public.seasonal_analysis(season_id);

-- RLS
alter table if exists public.seasonal_analysis enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'seasonal_analysis' and policyname = 'allow authenticated read seasonal_analysis'
  ) then
    create policy "allow authenticated read seasonal_analysis"
      on public.seasonal_analysis for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'seasonal_analysis' and policyname = 'allow authenticated write seasonal_analysis'
  ) then
    create policy "allow authenticated write seasonal_analysis"
      on public.seasonal_analysis for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 7. TRIGGERS FOR UPDATED_AT
-- =============================================================================
drop trigger if exists set_timestamp_suppliers on public.suppliers;
create trigger set_timestamp_suppliers
before update on public.suppliers
for each row execute procedure public.set_updated_at();

drop trigger if exists set_timestamp_supplier_rules on public.supplier_rules;
create trigger set_timestamp_supplier_rules
before update on public.supplier_rules
for each row execute procedure public.set_updated_at();

-- =============================================================================
-- 8. SEED DATA: Example supplier with BELL_RAIN tag
-- =============================================================================
-- Insert BELL_RAIN as a sample supplier (run once, will be ignored if exists)
insert into public.suppliers (name, tags, notes)
values ('BELL_RAIN', array['BELL_RAIN'], 'Secondary storage - pull stock first before buying new')
on conflict (name) do nothing;

