-- 27_sales_invoices_manual.sql
-- Allow manual edits of invoice rows that should be preserved during future scrapes

alter table if exists public.sales_invoices
  add column if not exists manual_edited boolean not null default false;

-- optional timestamp for auditing
alter table if exists public.sales_invoices
  add column if not exists updated_at timestamptz not null default now();

create index if not exists idx_sales_invoices_manual on public.sales_invoices(manual_edited);


