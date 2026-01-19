-- 136_styles_customs_tariff.sql
-- Add customs_tariff_no column to styles table
-- This is extracted from the sCustomsTariffNo select on the style detail page

alter table if exists public.styles
  add column if not exists customs_tariff_no text;

comment on column public.styles.customs_tariff_no is 'Customs tariff number from SPY style detail page (sCustomsTariffNo select, selected option text)';
