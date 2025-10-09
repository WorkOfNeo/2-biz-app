-- 09_domain_alter.sql
-- Add additional fields to domain tables

-- seasons: add year (integer)
alter table if exists public.seasons
  add column if not exists year int;

-- salespersons: add currency and sort_index for ordering
alter table if exists public.salespersons
  add column if not exists currency text;

alter table if exists public.salespersons
  add column if not exists sort_index int not null default 0;


