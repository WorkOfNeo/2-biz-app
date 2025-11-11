-- Expand jobs.type check constraint to include scrape_purchase_orders and fix_invoices
do $$
begin
  if exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'jobs_type_check' and table_name = 'jobs' and table_schema = 'public'
  ) then
    alter table public.jobs drop constraint jobs_type_check;
  end if;
  alter table public.jobs
    add constraint jobs_type_check check (type in (
      'scrape_statistics',
      'export_overview',
      'scrape_styles',
      'scrape_customers',
      'update_style_stock',
      'deep_scrape_styles',
      'scrape_top_styles',
      'export_top_styles',
      'scrape_purchase_orders',
      'fix_invoices'
    ));
end $$;

select pg_notify('pgrst', 'reload schema');


