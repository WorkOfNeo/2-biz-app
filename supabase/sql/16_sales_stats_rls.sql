-- 16_sales_stats_rls.sql

alter table public.sales_stats enable row level security;

drop policy if exists sales_stats_select_all on public.sales_stats;
create policy sales_stats_select_all on public.sales_stats for select to public using (true);

drop policy if exists sales_stats_insert_authenticated on public.sales_stats;
create policy sales_stats_insert_authenticated on public.sales_stats for insert to authenticated with check (true);

drop policy if exists sales_stats_update_authenticated on public.sales_stats;
create policy sales_stats_update_authenticated on public.sales_stats for update to authenticated using (true) with check (true);


