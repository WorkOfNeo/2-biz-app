-- 26_style_seasons.sql
-- Store per-style selected materials seasons (aggregated across colors)

create table if not exists public.style_seasons (
  id uuid primary key default gen_random_uuid(),
  style_no text not null,
  seasons jsonb not null default '[]'::jsonb, -- array of season labels (e.g., "25 WINTER")
  scraped_at timestamptz not null default now(),
  unique(style_no)
);

create index if not exists idx_style_seasons_style_no on public.style_seasons(style_no);


