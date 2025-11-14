-- 56_stock_lists.sql
-- Database-backed Stock Lists with per-list color selection
create table if not exists public.stock_lists (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.stock_list_styles (
  list_id uuid not null references public.stock_lists(id) on delete cascade,
  style_id uuid not null references public.styles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(list_id, style_id)
);

create table if not exists public.stock_list_colors (
  list_id uuid not null references public.stock_lists(id) on delete cascade,
  style_id uuid not null references public.styles(id) on delete cascade,
  style_color_id uuid not null references public.style_colors(id) on delete cascade,
  include boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(list_id, style_color_id)
);

create index if not exists idx_stock_list_styles_list_id on public.stock_list_styles(list_id);
create index if not exists idx_stock_list_styles_style_id on public.stock_list_styles(style_id);
create index if not exists idx_stock_list_colors_list_id on public.stock_list_colors(list_id);
create index if not exists idx_stock_list_colors_style_id on public.stock_list_colors(style_id);
create index if not exists idx_stock_list_colors_style_color_id on public.stock_list_colors(style_color_id);


