-- Daily rollup of movements per style/color/section/size (UTC day)
create or replace view public.v_style_movements_daily as
select
  style_no,
  color,
  coalesce(section, kind) as section,
  size,
  date_trunc('day', scraped_at)::date as day,
  sum(delta) as delta_day,
  min(prev_value) filter (where prev_value is not null) as first_value_seen,
  max(value) as last_value_seen
from public.style_stock_movements
group by 1,2,3,4,5;

-- Optional materialized view for heavy dashboards
-- create materialized view if not exists public.mv_style_movements_daily as
-- select
--   style_no,
--   color,
--   coalesce(section, kind) as section,
--   size,
--   date_trunc('day', scraped_at)::date as day,
--   sum(delta) as delta_day
-- from public.style_stock_movements
-- group by 1,2,3,4,5;
-- create index if not exists idx_mv_style_movements_daily_keys on public.mv_style_movements_daily(style_no, color, section, size, day);
-- To refresh: refresh materialized view concurrently public.mv_style_movements_daily;


