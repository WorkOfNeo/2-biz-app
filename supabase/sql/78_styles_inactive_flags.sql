-- 78_styles_inactive_flags.sql
-- Add columns to track inactive styles at the color level

alter table if exists public.style_colors
  add column if not exists maybe_inactive boolean not null default false;

alter table if exists public.style_colors
  add column if not exists inactive boolean not null default false;

comment on column public.style_colors.maybe_inactive is 'Automatically set to true when stock scrape finds all zeros for this color';
comment on column public.style_colors.inactive is 'Manually set to true to prevent future scraping of this color';

create index if not exists idx_style_colors_inactive on public.style_colors(inactive) where inactive = true;
create index if not exists idx_style_colors_maybe_inactive on public.style_colors(maybe_inactive) where maybe_inactive = true;

-- Keep inactive flag on styles table for manually marking entire styles
alter table if exists public.styles
  add column if not exists inactive boolean not null default false;

comment on column public.styles.inactive is 'Manually set to true to prevent future scraping of entire style';
create index if not exists idx_styles_inactive on public.styles(inactive) where inactive = true;

