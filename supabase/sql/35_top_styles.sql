-- Create table for scraped top styles per season
create table if not exists public.top_styles (
  id uuid primary key default gen_random_uuid(),
  season_id uuid references public.seasons(id) on delete cascade,
  style_no text not null,
  style_name text,
  color text,
  type text,
  quality text,
  image_url text,
  qty int not null default 0,
  sales_amount numeric not null default 0,
  sort_index int not null default 0,
  created_at timestamptz not null default now(),
  unique (season_id, style_no, color)
);

-- 35_top_styles.sql
-- Table to store Top 10 Styles per (current) season

create table if not exists public.top_styles (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  style_no text,
  style_name text,
  color text,
  type text,
  quality text,
  qty numeric not null default 0,
  amount numeric not null default 0,
  currency text,
  image_url text,
  created_at timestamptz not null default now()
);

create index if not exists idx_top_styles_season_qty_desc on public.top_styles(season_id, qty desc);

alter table public.top_styles enable row level security;
drop policy if exists top_styles_select_all on public.top_styles;
create policy top_styles_select_all on public.top_styles for select using (true);


