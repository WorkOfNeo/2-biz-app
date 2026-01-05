-- 104_purchase_sales_imports.sql
-- Tables for CSV import of row-level sales data for AI purchasing analysis

-- =============================================================================
-- 1. PURCHASE_SALES_IMPORTS TABLE (one row per upload)
-- =============================================================================
create table if not exists public.purchase_sales_imports (
  id uuid primary key default gen_random_uuid(),
  -- Context
  season_id uuid,
  name text, -- user-friendly name for the import
  -- Date range covered by the data
  date_range_start date,
  date_range_end date,
  -- Source info
  source text not null default 'csv', -- 'csv', 'api', 'scrape'
  file_name text,
  file_size_bytes integer,
  -- Stats
  row_count integer default 0,
  style_count integer default 0,
  customer_count integer default 0,
  total_qty integer default 0,
  total_amount numeric(12,2) default 0,
  -- Validation
  validation_errors jsonb default '[]', -- [{row, field, error}]
  is_valid boolean default true,
  -- Status
  status text not null check (status in ('pending', 'processing', 'completed', 'failed')) default 'pending',
  error text,
  -- Metadata
  created_by uuid,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists idx_purchase_sales_imports_season_id on public.purchase_sales_imports(season_id);
create index if not exists idx_purchase_sales_imports_created_at on public.purchase_sales_imports(created_at desc);
create index if not exists idx_purchase_sales_imports_status on public.purchase_sales_imports(status);

-- RLS
alter table if exists public.purchase_sales_imports enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_sales_imports' and policyname = 'allow authenticated read purchase_sales_imports'
  ) then
    create policy "allow authenticated read purchase_sales_imports"
      on public.purchase_sales_imports for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_sales_imports' and policyname = 'allow authenticated write purchase_sales_imports'
  ) then
    create policy "allow authenticated write purchase_sales_imports"
      on public.purchase_sales_imports for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 2. PURCHASE_SALES_ROWS TABLE (parsed row-level data)
-- =============================================================================
create table if not exists public.purchase_sales_rows (
  id bigserial primary key,
  import_id uuid not null references public.purchase_sales_imports(id) on delete cascade,
  -- Date
  date date not null,
  -- Customer (pseudonymized for AI, real for display)
  customer_ref text not null, -- HMAC-pseudonymized identifier sent to AI
  customer_display text, -- real name for UI display (NOT sent to AI)
  customer_id text, -- original ID from source system
  -- Geography
  country text,
  -- Sales rep
  sales_rep text,
  salesperson_id uuid, -- optional FK to salespersons table
  -- Style/Color
  style_no text not null,
  style_name text,
  color text not null,
  supplier text, -- denormalized for easy grouping
  -- Quantities
  qty integer not null default 0,
  -- Financials
  net_amount numeric(12,2) default 0,
  currency text default 'DKK',
  -- Order reference
  order_ref text, -- invoice/order ID
  channel text, -- e.g., 'wholesale', 'retail'
  -- Row metadata
  row_number integer, -- original row number in CSV
  created_at timestamptz not null default now()
);

-- Performance indexes for common queries
create index if not exists idx_purchase_sales_rows_import_id on public.purchase_sales_rows(import_id);
create index if not exists idx_purchase_sales_rows_style_color on public.purchase_sales_rows(style_no, color);
create index if not exists idx_purchase_sales_rows_customer_ref on public.purchase_sales_rows(customer_ref);
create index if not exists idx_purchase_sales_rows_supplier on public.purchase_sales_rows(supplier);
create index if not exists idx_purchase_sales_rows_sales_rep on public.purchase_sales_rows(sales_rep);
create index if not exists idx_purchase_sales_rows_date on public.purchase_sales_rows(date);
create index if not exists idx_purchase_sales_rows_country on public.purchase_sales_rows(country);

-- RLS
alter table if exists public.purchase_sales_rows enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_sales_rows' and policyname = 'allow authenticated read purchase_sales_rows'
  ) then
    create policy "allow authenticated read purchase_sales_rows"
      on public.purchase_sales_rows for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_sales_rows' and policyname = 'allow authenticated write purchase_sales_rows'
  ) then
    create policy "allow authenticated write purchase_sales_rows"
      on public.purchase_sales_rows for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- =============================================================================
-- 3. ADD FK CONSTRAINT TO PURCHASE_AI_RUNS (now that import table exists)
-- =============================================================================
-- Note: The FK was declared in 103 but the table didn't exist yet.
-- We add the constraint here if it doesn't exist.
do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints 
    where constraint_name = 'purchase_ai_runs_import_id_fkey' 
    and table_name = 'purchase_ai_runs'
  ) then
    alter table public.purchase_ai_runs
      add constraint purchase_ai_runs_import_id_fkey
      foreign key (import_id) references public.purchase_sales_imports(id) on delete set null;
  end if;
end $$;

-- =============================================================================
-- 4. AGGREGATION VIEW (for AI input generation)
-- =============================================================================
create or replace view public.purchase_sales_summary as
select
  import_id,
  supplier,
  style_no,
  color,
  count(distinct customer_ref) as customer_count,
  count(distinct country) as country_count,
  array_agg(distinct country) filter (where country is not null) as countries,
  count(distinct sales_rep) as sales_rep_count,
  sum(qty) as total_qty,
  sum(net_amount) as total_amount,
  avg(qty) as avg_qty_per_order,
  min(date) as first_sale_date,
  max(date) as last_sale_date
from public.purchase_sales_rows
group by import_id, supplier, style_no, color;

-- =============================================================================
-- 5. CUSTOMER SUMMARY VIEW (for coverage analysis)
-- =============================================================================
create or replace view public.purchase_customer_summary as
select
  import_id,
  customer_ref,
  customer_display,
  country,
  sales_rep,
  count(distinct style_no) as style_count,
  count(distinct concat(style_no, '|', color)) as style_color_count,
  sum(qty) as total_qty,
  sum(net_amount) as total_amount,
  count(*) as order_count
from public.purchase_sales_rows
group by import_id, customer_ref, customer_display, country, sales_rep;

