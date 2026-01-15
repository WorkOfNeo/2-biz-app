-- 131_purchase_ai_runs_pdf_and_job_type.sql
-- Add pdf_url column to purchase_ai_runs and add export_purchase_round_pdf to jobs type check

-- Add pdf_url column to purchase_ai_runs if not exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'purchase_ai_runs' 
    AND column_name = 'pdf_url'
  ) THEN
    ALTER TABLE public.purchase_ai_runs ADD COLUMN pdf_url text;
  END IF;
END $$;

-- Add export_purchase_round_pdf to jobs type check
-- First drop the existing constraint
ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_type_check;

-- Recreate with all job types including the new one
ALTER TABLE public.jobs ADD CONSTRAINT jobs_type_check CHECK (
  type IN (
    'scrape_customers',
    'scrape_purchase_orders',
    'scrape_styles',
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
    'export_purchase_round_pdf'
  )
);
