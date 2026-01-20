-- 139_jobs_add_scheduled_for.sql
-- Add scheduled_for column to jobs table to support delayed job execution

alter table if exists public.jobs
  add column if not exists scheduled_for timestamptz;

comment on column public.jobs.scheduled_for is 'When this job should be executed. If null, job can run immediately. If set, job will only be leased after this time.';

-- Update lease_next_job function to respect scheduled_for
create or replace function public.lease_next_job(
  p_now timestamptz,
  p_lease_until timestamptz,
  p_queue text default null
)
returns public.jobs
language plpgsql
as $$
declare
  v public.jobs;
begin
  with candidate as (
    select id
    from public.jobs
    where status in ('queued','running')
      and (lease_until is null or lease_until < p_now)
      and (scheduled_for is null or scheduled_for <= p_now)
      and (p_queue is null or queue = p_queue)
    order by (status = 'queued') desc, priority asc, created_at asc
    limit 1
    for update skip locked
  )
  update public.jobs j
     set status = 'running',
         started_at = coalesce(j.started_at, p_now),
         lease_until = p_lease_until
  from candidate c
  where j.id = c.id
  returning j.* into v;

  return v;
end $$;
