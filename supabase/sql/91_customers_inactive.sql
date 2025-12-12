-- 91_customers_inactive.sql
-- Add inactive field to customers table to mark orphaned customers instead of deleting them

alter table if exists public.customers
  add column if not exists inactive boolean not null default false;

comment on column public.customers.inactive is 'Set to true when customer is not found in SPY scrape (orphaned). Can be reactivated if customer reappears.';

create index if not exists idx_customers_inactive on public.customers(inactive) where inactive = true;

