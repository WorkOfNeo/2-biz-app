-- 85_supp_statistic.sql
-- Store aggregated supplier statistics per month per salesperson

create table if not exists public.supp_statistic (
  id uuid primary key default gen_random_uuid(),
  year_month text not null, -- Format: "2025-01" for January 2025
  salesperson_name text not null,
  total_leveret numeric not null default 0,
  telefon_stk numeric not null default 0,
  telefon_beløb numeric not null default 0, -- in cents
  b2b_stk numeric not null default 0,
  b2b_beløb numeric not null default 0, -- in cents
  krediteret_stk numeric not null default 0,
  krediteret_beløb numeric not null default 0, -- in cents
  samlet_stk numeric not null default 0,
  samlet_beløb numeric not null default 0, -- in cents
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(year_month, salesperson_name)
);

-- Indexes for efficient queries
create index if not exists idx_supp_statistic_year_month on public.supp_statistic(year_month desc);
create index if not exists idx_supp_statistic_salesperson on public.supp_statistic(salesperson_name);
create index if not exists idx_supp_statistic_created_at on public.supp_statistic(created_at desc);

-- updated_at trigger (reuse existing function)
drop trigger if exists trg_supp_statistic_updated_at on public.supp_statistic;
create trigger trg_supp_statistic_updated_at before update on public.supp_statistic
for each row execute procedure public.set_updated_at();

-- RLS policies
alter table if exists public.supp_statistic enable row level security;

drop policy if exists supp_statistic_select_authenticated on public.supp_statistic;
create policy supp_statistic_select_authenticated on public.supp_statistic
  for select using (true); -- Allow all authenticated users to read

drop policy if exists supp_statistic_insert_authenticated on public.supp_statistic;
create policy supp_statistic_insert_authenticated on public.supp_statistic
  for insert with check (true); -- Allow all authenticated users to insert

drop policy if exists supp_statistic_update_authenticated on public.supp_statistic;
create policy supp_statistic_update_authenticated on public.supp_statistic
  for update using (true); -- Allow all authenticated users to update

drop policy if exists supp_statistic_delete_authenticated on public.supp_statistic;
create policy supp_statistic_delete_authenticated on public.supp_statistic
  for delete using (true); -- Allow all authenticated users to delete

