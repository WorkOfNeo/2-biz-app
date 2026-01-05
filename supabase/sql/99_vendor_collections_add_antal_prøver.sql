-- 99_vendor_collections_add_antal_prøver.sql
-- Add antal_prøver (sample size) to vendor_collections for collection-level setting

-- Add the column if it doesn't exist
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_schema = 'public' 
    and table_name = 'vendor_collections' 
    and column_name = 'antal_prøver'
  ) then
    alter table public.vendor_collections 
    add column antal_prøver numeric not null default 9;
    
    comment on column public.vendor_collections.antal_prøver is 
      'Sample size multiplier for the entire collection (default 9)';
  end if;
end $$;




