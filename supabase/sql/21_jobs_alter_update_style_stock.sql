-- 21_jobs_alter_update_style_stock.sql
-- Ensure jobs.type includes 'update_style_stock'

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (type in ('scrape_statistics','scrape_styles','update_style_stock'));


