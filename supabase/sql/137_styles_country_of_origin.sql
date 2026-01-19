-- 137_styles_country_of_origin.sql
-- Add country_of_origin column to styles table
-- This is extracted from the origin_country_id select on the style detail page

alter table if exists public.styles
  add column if not exists country_of_origin text;

comment on column public.styles.country_of_origin is 'Country of origin from SPY style detail page (origin_country_id select, selected option text)';
