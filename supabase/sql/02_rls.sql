-- 02_rls.sql
-- Enable RLS on jobs, job_logs, job_results

alter table public.jobs enable row level security;
alter table public.job_logs enable row level security;
alter table public.job_results enable row level security;


