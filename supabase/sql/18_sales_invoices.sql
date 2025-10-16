-- 18_sales_invoices.sql
-- Stores individual invoiced rows scraped from SPY, to ensure idempotency and detailed views

create table if not exists public.sales_invoices (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  account_no text not null,
  customer_name text,
  qty numeric not null default 0,
  amount numeric not null default 0,
  currency text,
  invoice_no text not null,
  invoice_date text,
  created_at timestamptz not null default now(),
  unique(season_id, account_no, invoice_no)
);

create index if not exists idx_sales_invoices_season_account on public.sales_invoices(season_id, account_no);


