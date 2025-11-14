-- 55_season_currency_rates.sql
-- Season-specific currency conversion rates (DKK per unit) stored in app_settings
-- UI saves keys as: currency_rates:<season_id> with JSON payload like: { "EUR": 7.45, "NOK": 0.67, "SEK": 0.64 }
-- This migration adds a helper VIEW for convenient querying and analytics.

create or replace view public.season_currency_rates as
select
  regexp_replace(key, '^currency_rates:(.*)$', '\1') as season_id,
  nullif((value->>'EUR')::numeric, 0) as eur_rate_dkk,
  nullif((value->>'NOK')::numeric, 0) as nok_rate_dkk,
  nullif((value->>'SEK')::numeric, 0) as sek_rate_dkk,
  value as raw_json
from public.app_settings
where key like 'currency_rates:%';

comment on view public.season_currency_rates is 'Per-season currency conversion rates to DKK extracted from app_settings (currency_rates:<season_id>).';


