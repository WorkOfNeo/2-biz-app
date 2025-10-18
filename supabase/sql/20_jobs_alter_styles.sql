-- 20_jobs_alter_styles.sql
-- Ensure jobs.type allows the new 'scrape_styles' value on existing databases

alter table public.jobs drop constraint if exists jobs_type_check;
alter table public.jobs add constraint jobs_type_check check (type in ('scrape_statistics','scrape_styles'));


