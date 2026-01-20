-- 138_jobs_add_scrape_xlsx_sales_orders.sql
-- Add scrape_xlsx_sales_orders to jobs type check

-- First drop the existing constraint
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_type_check;

-- Recreate with all job types including the new one
ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check CHECK (
  type IN (
    'scrape_customers',
    'scrape_purchase_orders',
    'scrape_styles',
    'enrich_styles',
    'deep_scrape_styles',
    'update_style_stock',
    'check_stock_fix',
    'scrape_eans',
    'export_stock_list',
    'export_stock_list_after_update_stock',
    'export_suppleringer',
    'export_overview',
    'export_top_styles',
    'check_purchase_orders',
    'push_app_po_to_spy',
    'sync_app_po_from_spy',
    'scrape_top_styles',
    'scrape_statistics',
    'scrape_statistics_per_size',
    'scrape_style_raw_costs',
    'create_spy_stock_order',
    'fix_invoices',
    'apply_customer_preview',
    'send_email',
    'send_stock_list_email',
    'analyze_conversation_message',
    'run_ai_analysis',
    'export_ai_analysis',
    'export_purchase_round_pdf',
    'run_statistics_email_pipeline',
    'scrape_xlsx_sales_orders'
  )
);
