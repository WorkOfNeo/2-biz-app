-- 128_seasons_sale_delivery_dates.sql
-- Add sale start/end and latest delivery dates to seasons for purchase round context

ALTER TABLE public.seasons
  ADD COLUMN IF NOT EXISTS start_sale date,
  ADD COLUMN IF NOT EXISTS end_sale date,
  ADD COLUMN IF NOT EXISTS latest_delivery date;

COMMENT ON COLUMN public.seasons.start_sale IS 'First day of selling period for this season';
COMMENT ON COLUMN public.seasons.end_sale IS 'Last day of selling period for this season';
COMMENT ON COLUMN public.seasons.latest_delivery IS 'Latest acceptable delivery date for orders in this season';
