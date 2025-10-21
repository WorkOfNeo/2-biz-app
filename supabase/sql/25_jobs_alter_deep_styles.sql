-- 25_jobs_alter_deep_styles.sql
-- Allow new job type deep_scrape_styles and include all current types

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (
  type in (
    'scrape_statistics',
    'scrape_styles',
    'update_style_stock',
    'export_overview',
    'scrape_customers',
    'deep_scrape_styles'
  )
);


