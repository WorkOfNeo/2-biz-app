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
begin
  -- Reset jobs that are 'running' but lease has expired (more than 5 minutes ago)
  -- This indicates the worker crashed or lost connection
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
    lease_until,
    'queued'::text
  into job_id, job_type, job_status, lease_until, reset_to_status;
  
  return next;
  
  -- Also return jobs that are stuck in 'queued' with an old lease_until
  -- (shouldn't happen, but just in case)
  for job_id, job_type, job_status, lease_until, reset_to_status in
    select id, type, status, lease_until, 'queued'::text
    from public.jobs
    where status = 'queued'
      and lease_until is not null
      and lease_until < (v_now - interval '5 minutes')
      and (p_queue is null or queue = p_queue)
  loop
    update public.jobs
    set lease_until = null
    where id = job_id;
    
    return next;
  end loop;
  
  return;
end;
$$;

grant execute on function public.reset_stuck_jobs(text) to authenticated;

-- Example usage:
-- SELECT * FROM public.reset_stuck_jobs('fast');  -- Reset stuck jobs in 'fast' queue
-- SELECT * FROM public.reset_stuck_jobs();         -- Reset stuck jobs in all queues

