-- 86_supp_statistic_rows.sql
-- Store individual supplier statistic rows (raw data from XLSX upload)

create table if not exists public.supp_statistic_rows (
  id uuid primary key default gen_random_uuid(),
  year_month text not null, -- Format: "2025-01" for January 2025
  order_type text not null, -- "Stock" or "Pre"
  channel text not null, -- "Telefon" or "B2B Shop"
  customer_name text not null,
  account_no text not null,
  salesperson_name text not null,
  qty_ordered numeric not null default 0,
  qty_delivered numeric not null default 0,
  price numeric not null default 0, -- in cents
  date date, -- Date from BO column
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for efficient queries
create index if not exists idx_supp_statistic_rows_year_month on public.supp_statistic_rows(year_month desc);
create index if not exists idx_supp_statistic_rows_salesperson on public.supp_statistic_rows(salesperson_name);
create index if not exists idx_supp_statistic_rows_account_no on public.supp_statistic_rows(account_no);
create index if not exists idx_supp_statistic_rows_created_at on public.supp_statistic_rows(created_at desc);

-- Composite index for common queries
create index if not exists idx_supp_statistic_rows_month_salesperson on public.supp_statistic_rows(year_month, salesperson_name);

-- updated_at trigger (reuse existing function)
drop trigger if exists trg_supp_statistic_rows_updated_at on public.supp_statistic_rows;
create trigger trg_supp_statistic_rows_updated_at before update on public.supp_statistic_rows
for each row execute procedure public.set_updated_at();

-- RLS policies
alter table if exists public.supp_statistic_rows enable row level security;

drop policy if exists supp_statistic_rows_select_authenticated on public.supp_statistic_rows;
create policy supp_statistic_rows_select_authenticated on public.supp_statistic_rows
  for select using (true); -- Allow all authenticated users to read

drop policy if exists supp_statistic_rows_insert_authenticated on public.supp_statistic_rows;
create policy supp_statistic_rows_insert_authenticated on public.supp_statistic_rows
  for insert with check (true); -- Allow all authenticated users to insert

drop policy if exists supp_statistic_rows_update_authenticated on public.supp_statistic_rows;
create policy supp_statistic_rows_update_authenticated on public.supp_statistic_rows
  for update using (true); -- Allow all authenticated users to update

drop policy if exists supp_statistic_rows_delete_authenticated on public.supp_statistic_rows;
create policy supp_statistic_rows_delete_authenticated on public.supp_statistic_rows
  for delete using (true); -- Allow all authenticated users to delete

