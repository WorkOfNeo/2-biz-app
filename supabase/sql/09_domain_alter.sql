-- 09_domain_alter.sql
-- Add additional fields to domain tables

-- seasons: add year (integer)
alter table if exists public.seasons
  add column if not exists year int;

-- seasons: add Spy system season id (integer) and hidden flag
alter table if exists public.seasons
  add column if not exists spy_season_id int;

alter table if exists public.seasons
  add column if not exists hidden boolean not null default false;

-- salespersons: add currency and sort_index for ordering
alter table if exists public.salespersons
  add column if not exists currency text;

alter table if exists public.salespersons
  add column if not exists sort_index int not null default 0;

-- seasons: add display_currency (optional per-season currency override)
alter table if exists public.seasons
  add column if not exists display_currency text;

-- seasons: add spy_season_id mapping (numeric ID used by legacy SPY system)
alter table if exists public.seasons
  add column if not exists spy_season_id int;


-- seasons: allow manual name edits without scrape override
-- 1) drop unique on name (if created by initial DDL)
alter table if exists public.seasons
  drop constraint if exists seasons_name_key;

-- 2) add source_name (scraped) and name_overridden flag
alter table if exists public.seasons
  add column if not exists source_name text;

alter table if exists public.seasons
  add column if not exists name_overridden boolean not null default false;

-- 3) ensure unique mapping by spy_season_id when present
create unique index if not exists idx_seasons_spy_season_id_unique
  on public.seasons(spy_season_id)
  where spy_season_id is not null;


