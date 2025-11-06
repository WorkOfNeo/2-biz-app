-- Map seasons to specific style colors
create table if not exists public.style_color_seasons (
  style_color_id uuid not null references public.style_colors(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (style_color_id, season_id)
);

create index if not exists idx_style_color_seasons_color on public.style_color_seasons(style_color_id);
create index if not exists idx_style_color_seasons_season on public.style_color_seasons(season_id);


