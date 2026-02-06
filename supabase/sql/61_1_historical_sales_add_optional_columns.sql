-- 61_1_historical_sales_add_optional_columns.sql
-- Add optional order_type and order_channel columns to historical_sales

-- Add order_type column (optional)
alter table public.historical_sales 
add column if not exists order_type text;

-- Add order_channel column (optional)
alter table public.historical_sales 
add column if not exists order_channel text;

-- Add indexes for filtering by order type and channel
create index if not exists idx_historical_sales_order_type on public.historical_sales(order_type);
create index if not exists idx_historical_sales_order_channel on public.historical_sales(order_channel);
