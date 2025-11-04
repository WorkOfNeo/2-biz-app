-- 43_seasons_start_end.sql
-- Add start and end dates for seasons

alter table public.seasons
  add column if not exists start_date date,
  add column if not exists end_date date;


