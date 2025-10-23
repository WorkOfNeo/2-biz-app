-- 23_style_colors.sql
-- Colors per style and size set on styles

alter table if exists public.styles
  add column if not exists size_set jsonb;

create table if not exists public.style_colors (
  id uuid primary key default gen_random_uuid(),
  style_id uuid not null references public.styles(id) on delete cascade,
  color text not null,
  sort_index int not null default 0,
  scrape_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(style_id, color)
);

alter table if exists public.style_stock
  add column if not exists style_id uuid,
  add column if not exists style_color_id uuid;

do $$ begin
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema='public' and table_name='style_stock' and constraint_name='style_stock_style_id_fkey'
  ) then
    alter table public.style_stock
      add constraint style_stock_style_id_fkey foreign key(style_id) references public.styles(id) on delete cascade;
  end if;
  if not exists (
    select 1 from information_schema.table_constraints
    where table_schema='public' and table_name='style_stock' and constraint_name='style_stock_style_color_id_fkey'
  ) then
    alter table public.style_stock
      add constraint style_stock_style_color_id_fkey foreign key(style_color_id) references public.style_colors(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_style_stock_style_id on public.style_stock(style_id);
create index if not exists idx_style_stock_style_color_id on public.style_stock(style_color_id);


