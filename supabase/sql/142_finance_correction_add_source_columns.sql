-- 142_finance_correction_add_source_columns.sql
-- Add source columns to store original input data so we can re-process rows when loading

alter table if exists public.finance_correction_rows
  add column if not exists source_type text;

alter table if exists public.finance_correction_rows
  add column if not exists source_delivery text;

alter table if exists public.finance_correction_rows
  add column if not exists source_qty numeric(12, 2);

comment on column public.finance_correction_rows.source_type is 'Original Type value from uploaded file (Sales, Purchase, Correction)';
comment on column public.finance_correction_rows.source_delivery is 'Original Delivery value from uploaded file';
comment on column public.finance_correction_rows.source_qty is 'Original QTY value from uploaded file (before abs transformation)';
