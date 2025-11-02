-- Add DG free-text field to top_styles for manual notes
alter table if exists public.top_styles
  add column if not exists dg text;


