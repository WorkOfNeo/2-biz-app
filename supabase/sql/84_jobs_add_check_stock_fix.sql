-- 84_jobs_add_check_stock_fix.sql
-- Update job types constraint to include check_stock_fix

-- Drop the existing constraint
alter table public.jobs 
  drop constraint if exists jobs_type_check;

-- Add comprehensive constraint with all job types including check_stock_fix
alter table public.jobs 
  add constraint jobs_type_check 
  check (type IN (
    -- Original types
    'scrape_statistics',
    'scrape_styles',
    'update_style_stock',
    'export_overview',
    'scrape_customers',
    -- New customer scrape types
    'apply_customer_preview',
    -- Additional worker job types
    'scrape_eans',
    'enrich_styles',
    'deep_scrape_styles',
    'export_stock_list',
    'export_top_styles',
    'scrape_top_styles',
    'fix_invoices',
    'scrape_purchase_orders',
    'check_purchase_orders',
    'push_app_po_to_spy',
    'sync_app_po_from_spy',
    -- Stock verification job
    'check_stock_fix'
  ));

