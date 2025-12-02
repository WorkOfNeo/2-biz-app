-- 78_styles_inactive_flags.sql
-- Add columns to track inactive styles

alter table if exists public.styles
  add column if not exists maybe_inactive boolean not null default false;

alter table if exists public.styles
  add column if not exists inactive boolean not null default false;

comment on column public.styles.maybe_inactive is 'Automatically set to true when stock scrape finds all zeros';
comment on column public.styles.inactive is 'Manually set to true to prevent future scraping';

create index if not exists idx_styles_inactive on public.styles(inactive) where inactive = true;
create index if not exists idx_styles_maybe_inactive on public.styles(maybe_inactive) where maybe_inactive = true;

