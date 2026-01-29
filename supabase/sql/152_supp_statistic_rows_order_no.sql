-- 152_supp_statistic_rows_order_no.sql
-- Add order_no (Column A = order number) for deduplication and display.

alter table if exists public.supp_statistic_rows
  add column if not exists order_no text;

comment on column public.supp_statistic_rows.order_no is 'Order number from upload (Column A); can repeat for multiple lines per order.';

create index if not exists idx_supp_statistic_rows_year_month_order_no
  on public.supp_statistic_rows(year_month, order_no);
