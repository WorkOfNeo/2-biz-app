-- Add aggregated colors array to top_styles for display
alter table if exists public.top_styles
  add column if not exists colors text[] not null default '{}';


