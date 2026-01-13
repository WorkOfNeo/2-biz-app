-- 119_jobs_add_export_ai_analysis.sql
-- Add 'export_ai_analysis' job type for generating AI analysis PDF reports

alter table public.jobs
  drop constraint if exists jobs_type_check;

alter table public.jobs
  add constraint jobs_type_check 
  check (type IN (
    'scrape_statistics',
    'scrape_styles',
    'update_style_stock',
    'export_overview',
    'scrape_customers',
    'enrich_styles',
    'scrape_eans',
    'deep_scrape_styles',
    'export_top_styles',
    'export_stock_list',
    'scrape_top_styles',
    'scrape_statistics_per_size',
    'fix_invoices',
    'scrape_purchase_orders',
    'check_purchase_orders',
    'check_stock_fix',
    'export_suppleringer',
    'apply_customer_preview',
    'push_app_po_to_spy',
    'sync_app_po_from_spy',
    'create_spy_stock_order',
    'scrape_style_raw_costs',
    'send_stock_list_email',
    'send_email',
    'run_ai_analysis',
    'analyze_conversation_message',
    'export_ai_analysis'
  ));
