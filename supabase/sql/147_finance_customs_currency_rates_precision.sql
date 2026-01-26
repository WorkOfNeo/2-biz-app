-- 147_finance_customs_currency_rates_precision.sql
-- Increase precision for customs currency rates (need 6 decimals for DKK/USD etc.)

alter table if exists public.finance_customs_currency_rates
  alter column rate_dkk type numeric(12, 6);

comment on column public.finance_customs_currency_rates.rate_dkk is 'DKK per 1 unit (e.g. DKK/USD = X.XXXXXX).';

