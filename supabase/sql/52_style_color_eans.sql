-- 52_style_color_eans.sql
-- Stores EANs per style/color/size scraped from SPY #tab=ean

create table if not exists public.style_color_eans (
  id uuid primary key default gen_random_uuid(),
  style_id uuid references public.styles(id) on delete cascade,
  style_no text not null,
  style_color_id uuid references public.style_colors(id) on delete cascade,
  color text not null,
  size text not null,
  ean text not null,
  scraped_at timestamptz not null default now()
);

create index if not exists idx_eans_style on public.style_color_eans(style_no);
create index if not exists idx_eans_color on public.style_color_eans(color);
create index if not exists idx_eans_style_color on public.style_color_eans(style_no, color);
create unique index if not exists uq_eans_unique on public.style_color_eans(style_no, color, size, ean);

-- Enable public read if needed (optional)
-- alter table public.style_color_eans enable row level security;
-- create policy ean_select_all on public.style_color_eans for select using (true);


