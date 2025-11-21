-- 58_jobs_alter_add_export_stock_list.sql
-- Extend jobs.type CHECK constraint to include export_stock_list
-- Single-statement friendly (wrapped in DO block) for environments that don't allow multi-statements

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.jobs'::regclass
      and conname = 'jobs_type_check'
  ) then
    alter table public.jobs drop constraint if exists jobs_type_check;
  end if;
  alter table public.jobs
    add constraint jobs_type_check
    check (type in (
      'scrape_statistics',
      'scrape_styles',
      'update_style_stock',
      'export_overview',
      'scrape_customers',
      'deep_scrape_styles',
      'scrape_top_styles',
      'export_top_styles',
      'scrape_purchase_orders',
      'fix_invoices',
      'scrape_eans',
      'export_stock_list'
    )) not valid;
end $$;


