-- Add queue and priority to jobs, plus helpful index
alter table if exists public.jobs
  add column if not exists queue text not null default 'default',
  add column if not exists priority smallint not null default 100;

create index if not exists idx_jobs_status_queue_prio_created
  on public.jobs (status, queue, priority, created_at);


