-- 106_purchase_sales_with_images.sql
-- Enhanced views that join with styles to get image_url and additional style data

-- =============================================================================
-- 1. AGGREGATION VIEW WITH IMAGES (for AI input and UI display)
-- =============================================================================
create or replace view public.purchase_sales_summary_with_images as
select
  psr.import_id,
  psr.supplier,
  psr.style_no,
  psr.color,
  s.style_name,
  s.image_url,
  count(distinct psr.customer_ref) as customer_count,
  count(distinct psr.country) as country_count,
  array_agg(distinct psr.country) filter (where psr.country is not null) as countries,
  count(distinct psr.sales_rep) as sales_rep_count,
  sum(psr.qty) as total_qty,
  sum(psr.net_amount) as total_amount,
  avg(psr.qty) as avg_qty_per_order,
  min(psr.date) as first_sale_date,
  max(psr.date) as last_sale_date
from public.purchase_sales_rows psr
left join public.styles s on s.style_no = psr.style_no
group by psr.import_id, psr.supplier, psr.style_no, psr.color, s.style_name, s.image_url;

-- =============================================================================
-- 2. ADD SIZE COLUMN TO PURCHASE_SALES_ROWS IF NOT EXISTS
-- =============================================================================
alter table if exists public.purchase_sales_rows
  add column if not exists size text;

create index if not exists idx_purchase_sales_rows_size on public.purchase_sales_rows(size);

-- =============================================================================
-- 3. SIZE-LEVEL SUMMARY VIEW (for detailed size breakdown)
-- =============================================================================
create or replace view public.purchase_sales_size_summary as
select
  import_id,
  supplier,
  style_no,
  color,
  size,
  sum(qty) as total_qty,
  sum(net_amount) as total_amount,
  count(distinct customer_ref) as customer_count
from public.purchase_sales_rows
where size is not null
group by import_id, supplier, style_no, color, size;

