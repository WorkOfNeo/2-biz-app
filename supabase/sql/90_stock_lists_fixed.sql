-- 90_stock_lists_fixed.sql
-- Create fixed stock lists and migrate existing "Aktiv liste" to "Aktiv"

-- First, add a 'fixed' column to mark system lists that cannot be deleted
alter table public.stock_lists
  add column if not exists fixed boolean not null default false;

-- Create fixed stock lists (use INSERT ... ON CONFLICT to make this idempotent)
do $$
declare
  nye_id uuid;
  aktiv_id uuid;
  passiv_id uuid;
  noos_id uuid;
  intet_id uuid;
begin
  -- Insert fixed lists with specific IDs for consistency
  insert into public.stock_lists (id, name, fixed, created_at, updated_at)
  values 
    ('00000000-0000-0000-0000-000000000001'::uuid, 'Nye styles', true, now(), now()),
    ('00000000-0000-0000-0000-000000000002'::uuid, 'Aktiv', true, now(), now()),
    ('00000000-0000-0000-0000-000000000003'::uuid, 'Passiv', true, now(), now()),
    ('00000000-0000-0000-0000-000000000004'::uuid, 'NOOS', true, now(), now()),
    ('00000000-0000-0000-0000-000000000005'::uuid, 'Intet', true, now(), now())
  on conflict (name) do update
    set fixed = true, updated_at = now();
  
  -- Get the Aktiv list ID
  select id into aktiv_id from public.stock_lists where name = 'Aktiv';
  
  -- Migrate existing "Aktiv liste" to "Aktiv" if it exists
  -- Find any list with name containing "Aktiv" (case-insensitive) but not exactly "Aktiv"
  if exists (select 1 from public.stock_lists where lower(name) like '%aktiv%' and name != 'Aktiv') then
    -- Get the first matching list
    declare
      old_list_id uuid;
    begin
      select id into old_list_id 
      from public.stock_lists 
      where lower(name) like '%aktiv%' and name != 'Aktiv'
      limit 1;
      
      -- Migrate stock_list_styles entries
      insert into public.stock_list_styles (list_id, style_id, created_at, updated_at)
      select aktiv_id, style_id, created_at, updated_at
      from public.stock_list_styles
      where list_id = old_list_id
      on conflict (list_id, style_id) do nothing;
      
      -- Migrate stock_list_colors entries
      insert into public.stock_list_colors (list_id, style_id, style_color_id, include, created_at, updated_at)
      select aktiv_id, style_id, style_color_id, include, created_at, updated_at
      from public.stock_list_colors
      where list_id = old_list_id
      on conflict (list_id, style_color_id) do nothing;
      
      -- Delete the old list (cascade will handle related records)
      delete from public.stock_lists where id = old_list_id;
      
      raise notice 'Migrated old Aktiv liste (%) to Aktiv (%)', old_list_id, aktiv_id;
    end;
  end if;
end $$;

-- Create index on fixed column for faster queries
create index if not exists idx_stock_lists_fixed on public.stock_lists(fixed) where fixed = true;

-- Add comment explaining the fixed lists
comment on column public.stock_lists.fixed is 'System-managed lists that cannot be deleted by users (Nye styles, Aktiv, Passiv, NOOS, Intet)';

