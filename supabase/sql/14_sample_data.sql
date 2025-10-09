-- 14_sample_data.sql
-- Minimal sample data for development

insert into public.salespersons (name)
values ('Alice'), ('Bob')
on conflict do nothing;

insert into public.customers (customer_id, company, stats_display_name, city, country, salesperson_id)
select 'CUST001', 'Acme A/S', 'Acme', 'Copenhagen', 'DK', id from public.salespersons where name='Alice'
on conflict (customer_id) do nothing;

insert into public.customers (customer_id, company, stats_display_name, city, country, salesperson_id)
select 'CUST002', 'Globex ApS', 'Globex', 'Aarhus', 'DK', id from public.salespersons where name='Bob'
on conflict (customer_id) do nothing;

insert into public.seasons (name, year) values ('AW', extract(year from now())::int)
on conflict (name, year) do nothing;

-- link season id variable
with s as (
  select id from public.seasons where name='AW' and year=extract(year from now())::int
)
insert into public.season_statistics (customer_id, season_id, qty, amount, currency)
select c.id, s.id, 10, 1000, 'DKK' from public.customers c cross join s where c.customer_id='CUST001'
on conflict (customer_id, season_id) do nothing;


