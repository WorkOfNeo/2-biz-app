-- 17_sales_stats_indexes.sql

create index if not exists sales_stats_season_id_idx on public.sales_stats(season_id);
create index if not exists sales_stats_customer_id_idx on public.sales_stats(customer_id);
create index if not exists sales_stats_salesperson_id_idx on public.sales_stats(salesperson_id);


