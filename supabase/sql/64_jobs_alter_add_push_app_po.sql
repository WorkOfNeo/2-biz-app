-- Extend jobs.type check constraint to include 'push_app_po_to_spy'
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'jobs_type_check') then
    alter table public.jobs drop constraint jobs_type_check;
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
      'export_stock_list',
      'check_purchase_orders',
      'push_app_po_to_spy'
    ));
end $$;

