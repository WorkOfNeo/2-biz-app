-- 08_domain_indexes.sql

create index if not exists customers_customer_id_idx on public.customers(customer_id);
create index if not exists customers_salesperson_id_idx on public.customers(salesperson_id);
create index if not exists season_statistics_customer_season_idx on public.season_statistics(customer_id, season_id);


