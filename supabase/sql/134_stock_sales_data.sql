-- 134_stock_sales_data.sql
-- Stores aggregated sales data per style/color/size from XLSX sales orders
-- One row per style/color/size combination with total quantity across all customers

create table if not exists public.stock_sales_data (
  id uuid primary key default gen_random_uuid(),
  style_no text not null,
  color text not null,
  size text not null,
  total_qty numeric not null default 0,
  scraped_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  
  constraint unique_style_color_size unique (style_no, color, size)
);

-- Indexes for efficient queries
create index if not exists idx_stock_sales_data_style_no on public.stock_sales_data(style_no);
create index if not exists idx_stock_sales_data_style_color on public.stock_sales_data(style_no, color);
create index if not exists idx_stock_sales_data_scraped_at on public.stock_sales_data(scraped_at desc);

-- updated_at trigger (reuse existing function)
drop trigger if exists trg_stock_sales_data_updated_at on public.stock_sales_data;
create trigger trg_stock_sales_data_updated_at before update on public.stock_sales_data
for each row execute procedure public.set_updated_at();

-- Enable RLS
alter table if exists public.stock_sales_data enable row level security;

-- RLS policies
drop policy if exists stock_sales_data_select_all on public.stock_sales_data;
create policy stock_sales_data_select_all on public.stock_sales_data for select to public using (true);

drop policy if exists stock_sales_data_insert_authenticated on public.stock_sales_data;
create policy stock_sales_data_insert_authenticated on public.stock_sales_data for insert to authenticated with check (true);

drop policy if exists stock_sales_data_update_authenticated on public.stock_sales_data;
create policy stock_sales_data_update_authenticated on public.stock_sales_data for update to authenticated using (true) with check (true);

drop policy if exists stock_sales_data_delete_authenticated on public.stock_sales_data;
create policy stock_sales_data_delete_authenticated on public.stock_sales_data for delete to authenticated using (true);
