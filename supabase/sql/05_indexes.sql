-- 05_indexes.sql

create index if not exists jobs_status_idx on public.jobs(status);
create index if not exists jobs_lease_until_idx on public.jobs(lease_until);
create index if not exists jobs_created_at_desc_idx on public.jobs(created_at desc);
create index if not exists job_logs_job_id_idx on public.job_logs(job_id);
create index if not exists job_results_job_id_idx on public.job_results(job_id);


