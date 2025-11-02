-- Make top_styles unique per (season_id, style_no) to upsert by style number
do $$
begin
  -- Drop existing unique constraint on (season_id, style_no, color) if present
  if exists (
    select 1 from pg_constraint
    where conname = 'top_styles_season_style_color_key'
      and conrelid = 'public.top_styles'::regclass
  ) then
    alter table public.top_styles drop constraint top_styles_season_style_color_key;
  end if;
  -- Create unique constraint on (season_id, style_no)
  if not exists (
    select 1 from pg_constraint
    where conname = 'top_styles_season_style_key'
      and conrelid = 'public.top_styles'::regclass
  ) then
    alter table public.top_styles
      add constraint top_styles_season_style_key unique (season_id, style_no);
  end if;
end $$;

-- Ensure required columns exist (idempotent)
alter table if exists public.top_styles
  add column if not exists style_name text,
  add column if not exists image_url text,
  add column if not exists type text,
  add column if not exists quality text,
  add column if not exists qty int not null default 0,
  add column if not exists sales_amount numeric not null default 0,
  add column if not exists sort_index int not null default 0,
  add column if not exists created_at timestamptz not null default now();

-- Ask PostgREST to reload schema cache so upsert(onConflict: 'season_id,style_no') works
select pg_notify('pgrst', 'reload schema');


