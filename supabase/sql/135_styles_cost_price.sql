-- 135_styles_cost_price.sql
-- Add cost_price and cost_price_currency columns to styles table
-- These are extracted from the #calculation table on the style detail page

alter table if exists public.styles
  add column if not exists cost_price numeric(12, 2);

alter table if exists public.styles
  add column if not exists cost_price_currency text;

comment on column public.styles.cost_price is 'Raw cost price from SPY style detail page (#calculation table, sOfferprice input)';
comment on column public.styles.cost_price_currency is 'Currency code (DKK, NOK, SEK, EUR, USD) from SPY style detail page (#calculation table, cp_exchange_id select)';
