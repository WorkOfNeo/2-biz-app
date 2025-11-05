-- Extend customers with optional fields used by settings UI and scrapers
alter table if exists public.customers
  add column if not exists phone text,
  add column if not exists priority int,
  add column if not exists orders_link text,
  add column if not exists spy_id text;


