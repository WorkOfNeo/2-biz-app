-- 22_style_stock.sql
-- Stores parsed statAndStockDetails per style/color snapshot

create table if not exists public.style_stock (
  id uuid primary key default gen_random_uuid(),
  style_no text not null,
  color text not null,
  sizes jsonb not null default '[]'::jsonb, -- array of size labels in column order
  section text not null, -- 'Stock' | 'Sold' | 'Available' | 'PO Available' | 'Purchase (Running + Shipped)' | 'Total PO (Run + Ship)' | etc.
  row_label text, -- e.g., 'Total sold', '25 WINTER', '10 PCS', 'BR7225'
  values jsonb not null default '[]'::jsonb, -- numeric array across sizes plus total if present
  po_link text, -- href when present on purchase rows
  scraped_at timestamptz not null default now()
);

create index if not exists idx_style_stock_style_no on public.style_stock(style_no);
create index if not exists idx_style_stock_scraped_at on public.style_stock(scraped_at desc);


