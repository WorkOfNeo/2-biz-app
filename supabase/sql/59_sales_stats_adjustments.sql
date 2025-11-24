-- 59_sales_stats_adjustments.sql
-- Manual adjustment rows per customer (account_no) and season, to tweak qty/price totals

create table if not exists public.sales_stats_adjustments (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  account_no text not null,
  qty_delta numeric not null default 0,
  price_delta numeric not null default 0,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_sales_stats_adj_season_account on public.sales_stats_adjustments(season_id, account_no);

alter table public.sales_stats_adjustments enable row level security;

drop policy if exists sales_stats_adjustments_select_all on public.sales_stats_adjustments;
create policy sales_stats_adjustments_select_all on public.sales_stats_adjustments for select to public using (true);

drop policy if exists sales_stats_adjustments_insert_auth on public.sales_stats_adjustments;
create policy sales_stats_adjustments_insert_auth on public.sales_stats_adjustments for insert to authenticated with check (true);

drop policy if exists sales_stats_adjustments_update_auth on public.sales_stats_adjustments;
create policy sales_stats_adjustments_update_auth on public.sales_stats_adjustments for update to authenticated using (true) with check (true);


