-- Add kind (stock|sold) to movements to support multiple change types
alter table if exists public.style_stock_movements
  add column if not exists kind text not null default 'stock';

create index if not exists idx_style_stock_movements_kind on public.style_stock_movements(kind);


