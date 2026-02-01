-- 140_lease_next_job_serial_manual_sendout.sql
-- Ensure run_manual_sendout_pipeline jobs run serially (never concurrent),
-- even if multiple workers are leasing from the same queue.
--
-- This prevents a queued manual sendout from being leased while another manual
-- sendout is already in status=running.

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
      and not (
        status = 'queued'
        and type = 'run_manual_sendout_pipeline'
        and exists (
          select 1
          from public.jobs j2
          where j2.type = 'run_manual_sendout_pipeline'
            and j2.status = 'running'
        )
      )
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

