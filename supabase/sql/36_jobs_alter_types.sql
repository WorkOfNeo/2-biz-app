-- Expand jobs.type check constraint to include scrape_top_styles
do $$
begin
  -- Drop existing constraint if present
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'jobs_type_check' and table_name = 'jobs' and table_schema = 'public'
  ) then
    alter table public.jobs drop constraint jobs_type_check;
  end if;
  -- Recreate with expanded set
  alter table public.jobs
    add constraint jobs_type_check check (type in (
      'scrape_statistics',
      'export_overview',
      'scrape_top_styles'
    ));
end $$;

-- 36_jobs_alter_types.sql
-- Expand jobs.type check constraint to include new job types

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs
  add constraint jobs_type_check
  check (type in (
    'scrape_statistics',
    'scrape_styles',
    'update_style_stock',
    'export_overview',
    'scrape_customers',
    'deep_scrape_styles',
    'scrape_top_styles'
  ));


