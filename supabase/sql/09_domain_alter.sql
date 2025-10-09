-- 09_domain_alter.sql
-- Add additional fields to domain tables

-- seasons: add year (integer)
alter table if exists public.seasons
  add column if not exists year int;


