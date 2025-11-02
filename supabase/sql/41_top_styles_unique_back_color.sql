-- Revert uniqueness to (season_id, style_no, color) so rows are per color
do $$
begin
  -- Drop unique(season_id,style_no) if present
  if exists (
    select 1 from pg_constraint
    where conname = 'top_styles_season_style_key'
      and conrelid = 'public.top_styles'::regclass
  ) then
    alter table public.top_styles drop constraint top_styles_season_style_key;
  end if;
  -- Create unique(season_id, style_no, color) if missing
  if not exists (
    select 1 from pg_constraint
    where conname = 'top_styles_season_style_color_key'
      and conrelid = 'public.top_styles'::regclass
  ) then
    alter table public.top_styles
      add constraint top_styles_season_style_color_key unique (season_id, style_no, color);
  end if;
end $$;

select pg_notify('pgrst', 'reload schema');


