-- Add DG field on styles to store designer/group number (from Top 10 editor)
alter table if exists public.styles
  add column if not exists dg text;

-- Helpful index when filtering by DG (optional)
create index if not exists idx_styles_dg on public.styles(dg);


