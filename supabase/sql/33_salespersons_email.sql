-- 33_salespersons_email.sql
-- Add email field to salespersons

alter table if exists public.salespersons
  add column if not exists email text;

-- Optional index if you plan to lookup by email often
-- create index if not exists idx_salespersons_email on public.salespersons(lower(email));


