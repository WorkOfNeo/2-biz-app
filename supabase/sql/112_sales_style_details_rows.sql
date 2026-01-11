-- 112_sales_style_details_rows.sql
-- Stores per-size style details parsed from SPY bulk downloads (style details excel/csv)

create table if not exists public.sales_style_details_rows (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  account_no text not null,
  style_no text not null,
  style_name text,
  quality text,
  color text,
  size text,
  qty numeric not null default 0,
  barcode text,
  scraped_at timestamptz not null default now()
);

-- Indexes for fast lookup
create index if not exists idx_sales_style_details_rows_season_account on public.sales_style_details_rows(season_id, account_no);
create index if not exists idx_sales_style_details_rows_season_style on public.sales_style_details_rows(season_id, style_no);

-- Enable RLS
alter table public.sales_style_details_rows enable row level security;

-- RLS: select public (read)
drop policy if exists sales_style_details_rows_select_all on public.sales_style_details_rows;
create policy sales_style_details_rows_select_all on public.sales_style_details_rows for select to public using (true);

-- RLS: insert authenticated
drop policy if exists sales_style_details_rows_insert_authenticated on public.sales_style_details_rows;
create policy sales_style_details_rows_insert_authenticated on public.sales_style_details_rows for insert to authenticated with check (true);

-- RLS: update authenticated
drop policy if exists sales_style_details_rows_update_authenticated on public.sales_style_details_rows;
create policy sales_style_details_rows_update_authenticated on public.sales_style_details_rows for update to authenticated using (true) with check (true);

-- RLS: delete authenticated
drop policy if exists sales_style_details_rows_delete_authenticated on public.sales_style_details_rows;
create policy sales_style_details_rows_delete_authenticated on public.sales_style_details_rows for delete to authenticated using (true);
