-- 77_style_color_missing_tracker.sql
-- Track style+color combinations that disappear from scrapes to auto-delete after 3 consecutive misses

create table if not exists public.style_color_missing_tracker (
  id uuid primary key default gen_random_uuid(),
  style_no text not null,
  color text not null,
  consecutive_misses int not null default 0,
  last_seen_at timestamptz not null,
  last_checked_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique(style_no, color)
);

create index if not exists idx_style_color_missing_tracker_style_no 
  on public.style_color_missing_tracker(style_no);

create index if not exists idx_style_color_missing_tracker_misses 
  on public.style_color_missing_tracker(consecutive_misses) 
  where consecutive_misses >= 3;

-- RPC function to increment missing count
create or replace function public.increment_missing_color(
  p_style_no text,
  p_color text
) returns void as $$
begin
  insert into public.style_color_missing_tracker (
    style_no, 
    color, 
    consecutive_misses, 
    last_checked_at,
    last_seen_at
  ) values (
    p_style_no,
    p_color,
    1,
    now(),
    now() - interval '1 day'
  )
  on conflict (style_no, color) do update set
    consecutive_misses = style_color_missing_tracker.consecutive_misses + 1,
    last_checked_at = now();
end;
$$ language plpgsql;

-- RLS policies
alter table public.style_color_missing_tracker enable row level security;

drop policy if exists style_color_missing_tracker_select_all on public.style_color_missing_tracker;
create policy style_color_missing_tracker_select_all 
  on public.style_color_missing_tracker 
  for select to public using (true);

drop policy if exists style_color_missing_tracker_write_authenticated on public.style_color_missing_tracker;
create policy style_color_missing_tracker_write_authenticated 
  on public.style_color_missing_tracker 
  for all to authenticated using (true);

