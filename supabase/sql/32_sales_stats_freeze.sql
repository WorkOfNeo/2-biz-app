-- 32_sales_stats_freeze.sql
-- Add a freeze flag to prevent automated updates for specific rows

alter table if exists public.sales_stats
  add column if not exists frozen boolean not null default false;

create index if not exists idx_sales_stats_frozen on public.sales_stats(frozen);


