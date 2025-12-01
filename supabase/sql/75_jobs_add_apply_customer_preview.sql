-- 75_jobs_add_apply_customer_preview.sql
-- Add 'apply_customer_preview' to allowed job types

-- Drop the existing constraint
alter table public.jobs 
  drop constraint if exists jobs_type_check;

-- Add the new constraint with the additional job type
alter table public.jobs 
  add constraint jobs_type_check 
  check (type in (
    'scrape_statistics',
    'scrape_styles',
    'update_style_stock',
    'export_overview',
    'scrape_customers',
    'apply_customer_preview'
  ));

