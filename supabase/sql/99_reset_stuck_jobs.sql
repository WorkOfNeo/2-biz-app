-- 99_reset_stuck_jobs.sql
-- Utility function to reset stuck jobs (jobs that are 'running' but lease_until has expired)
-- This can happen if a worker crashes while processing a job

-- Function to reset stuck jobs for a specific queue
create or replace function public.reset_stuck_jobs(p_queue text default null)
returns table(
  job_id uuid,
  job_type text,
  job_status text,
  lease_until timestamptz,
  reset_to_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_rec record;
begin
  -- Reset jobs that are 'running' but lease has expired (more than 5 minutes ago)
  -- This indicates the worker crashed or lost connection
  for v_rec in
    update public.jobs
    set 
      status = 'queued',
      lease_until = null,
      error = null
    where status = 'running'
      and lease_until is not null
      and lease_until < (v_now - interval '5 minutes')
      and (p_queue is null or queue = p_queue)
    returning 
      id,
      type,
      status,
      lease_until
  loop
    job_id := v_rec.id;
    job_type := v_rec.type;
    job_status := v_rec.status;
    lease_until := v_rec.lease_until;
    reset_to_status := 'queued';
    return next;
  end loop;
  
  -- Also reset jobs that are stuck in 'queued' with an old lease_until
  -- (shouldn't happen, but just in case)
  for v_rec in
    update public.jobs
    set lease_until = null
    where status = 'queued'
      and lease_until is not null
      and lease_until < (v_now - interval '5 minutes')
      and (p_queue is null or queue = p_queue)
    returning 
      id,
      type,
      status,
      lease_until
  loop
    job_id := v_rec.id;
    job_type := v_rec.type;
    job_status := v_rec.status;
    lease_until := v_rec.lease_until;
    reset_to_status := 'queued';
    return next;
  end loop;
  
  return;
end;
$$;

grant execute on function public.reset_stuck_jobs(text) to authenticated;

-- Example usage:
-- SELECT * FROM public.reset_stuck_jobs('fast');  -- Reset stuck jobs in 'fast' queue
-- SELECT * FROM public.reset_stuck_jobs();         -- Reset stuck jobs in all queues

