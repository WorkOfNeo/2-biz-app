-- 82_verify_and_fix_inactive.sql
-- Ensure inactive column exists and is properly configured

-- Add inactive column to styles table if it doesn't exist
alter table if exists public.styles
  add column if not exists inactive boolean not null default false;

-- Add maybe_inactive column to styles table if it doesn't exist
alter table if exists public.styles
  add column if not exists maybe_inactive boolean not null default false;

-- Add comments
comment on column public.styles.inactive is 'Manually set to true to prevent future scraping of entire style';
comment on column public.styles.maybe_inactive is 'Automatically set to true when stock scrape finds issues';

-- Create indexes
create index if not exists idx_styles_inactive on public.styles(inactive) where inactive = true;
create index if not exists idx_styles_maybe_inactive on public.styles(maybe_inactive) where maybe_inactive = true;

-- Verify RLS policies allow updates (drop and recreate to ensure correct permissions)
drop policy if exists "Allow authenticated users to update styles" on public.styles;

create policy "Allow authenticated users to update styles"
  on public.styles
  for update
  to authenticated
  using (true)
  with check (true);

-- Verify the column exists
do $$
begin
  if exists (
    select 1 
    from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'styles' 
    and column_name = 'inactive'
  ) then
    raise notice 'SUCCESS: inactive column exists on styles table';
  else
    raise exception 'ERROR: inactive column does NOT exist on styles table';
  end if;
end $$;

