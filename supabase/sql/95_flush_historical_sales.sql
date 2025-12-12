-- 95_flush_historical_sales.sql
-- Flush all historical sales data
-- Run this manually when you need to clear and reload historical sales

truncate table public.historical_sales restart identity cascade;

-- Alternative if you want to keep the sequence/identities:
-- delete from public.historical_sales;

-- Verify:
-- select count(*) from public.historical_sales;

