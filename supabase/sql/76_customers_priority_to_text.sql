-- 76_customers_priority_to_text.sql
-- Change priority column from int to text since SPY uses letter codes (A, B, C, D, etc.)

alter table public.customers 
  alter column priority type text using priority::text;

