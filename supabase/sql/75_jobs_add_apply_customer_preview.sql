-- 75_jobs_add_apply_customer_preview.sql
-- Update job types constraint to include all job types used in the worker

-- Drop the existing constraint
alter table public.jobs 
  drop constraint if exists jobs_type_check;

-- Add comprehensive constraint with all job types
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
    'deep_scrape_styles',
    'export_stock_list',
    'export_top_styles',
    'scrape_top_styles',
    'fix_invoices',
    'scrape_purchase_orders',
    'check_purchase_orders',
    'push_app_po_to_spy',
    'sync_app_po_from_spy'
  ));

