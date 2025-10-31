-- 34_seasons_current.sql
-- Add is_current flag to seasons, and a partial unique index so only one season can be current

alter table if exists public.seasons
  add column if not exists is_current boolean not null default false;

create unique index if not exists idx_seasons_is_current_unique
  on public.seasons(is_current)
  where is_current = true;


