-- 79_styles_stock_all_zeros.sql
-- Add flag to mark styles that have all-zero stock or encounter scraping errors

alter table if exists public.styles
  add column if not exists stock_all_zeros boolean not null default false;

comment on column public.styles.stock_all_zeros is 'Automatically set to true when style has all zeros (stock, sold, purchase) across all colors, or when scraping encounters errors. Styles with this flag will be skipped in future scrapes.';

create index if not exists idx_styles_stock_all_zeros on public.styles(stock_all_zeros) where stock_all_zeros = true;

