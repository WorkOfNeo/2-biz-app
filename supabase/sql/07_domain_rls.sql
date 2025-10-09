-- 07_domain_rls.sql
-- Enable RLS and basic read policies for domain tables

alter table public.salespersons enable row level security;
alter table public.customers enable row level security;
alter table public.seasons enable row level security;
alter table public.season_statistics enable row level security;

drop policy if exists salespersons_select_all on public.salespersons;
create policy salespersons_select_all on public.salespersons for select to public using (true);

drop policy if exists customers_select_all on public.customers;
create policy customers_select_all on public.customers for select to public using (true);

drop policy if exists seasons_select_all on public.seasons;
create policy seasons_select_all on public.seasons for select to public using (true);

drop policy if exists season_statistics_select_all on public.season_statistics;
create policy season_statistics_select_all on public.season_statistics for select to public using (true);

-- No anon writes; service role bypasses RLS for inserts/updates.


