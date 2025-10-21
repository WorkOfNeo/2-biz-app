-- 24_style_stock_alter.sql
-- Make row_label not null with default '', add updated_at, and add upsert key

alter table public.style_stock alter column row_label set default '';
update public.style_stock set row_label = '' where row_label is null;
alter table public.style_stock alter column row_label set not null;

alter table public.style_stock add column if not exists updated_at timestamptz not null default now();

drop index if exists uq_style_stock_key;
create unique index uq_style_stock_key on public.style_stock(style_no, color, section, row_label);

-- Store deep-scraped seasons per style color (from materials tab)
create table if not exists public.style_color_materials (
  id uuid primary key default gen_random_uuid(),
  style_no text not null,
  color text not null,
  season_ids jsonb not null default '[]'::jsonb,
  scraped_at timestamptz not null default now(),
  unique(style_no, color)
);


