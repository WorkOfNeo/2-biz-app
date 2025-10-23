-- 19_styles.sql
-- Stores scraped styles list for search and linking

create table if not exists public.styles (
  id uuid primary key default gen_random_uuid(),
  spy_id text, -- data-reference attr
  style_no text not null,
  style_name text,
  supplier text,
  image_url text,
  link_href text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_styles_style_no on public.styles(style_no);
create index if not exists idx_styles_name on public.styles using gin (to_tsvector('simple', coalesce(style_name,'')));

-- Enable toggling scrape at style level
alter table if exists public.styles
  add column if not exists scrape_enabled boolean not null default true;
