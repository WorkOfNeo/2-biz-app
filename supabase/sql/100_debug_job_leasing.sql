-- 100_debug_job_leasing.sql
-- Diagnostic queries to debug job leasing issues

-- 1. Check jobs in fast queue that should be leasable
create or replace function public.debug_fast_queue_jobs()
returns table(
  job_id uuid,
  job_type text,
  job_status text,
  job_queue text,
  lease_until timestamptz,
  created_at timestamptz,
  is_leasable boolean,
  reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
begin
  return query
  select 
    j.id,
    j.type,
    j.status,
    j.queue,
    j.lease_until,
    j.created_at,
    case
      when j.status = 'queued' and (j.lease_until is null or j.lease_until < v_now) then true
      when j.status = 'running' and j.lease_until is not null and j.lease_until < v_now then true
      else false
    end as is_leasable,
    case
      when j.status not in ('queued', 'running') then 'Status is ' || j.status
      when j.lease_until is not null and j.lease_until >= v_now then 'Lease still valid until ' || j.lease_until::text
      when j.queue != 'fast' then 'Queue is ' || j.queue || ' (not fast)'
      else 'Should be leasable'
    end as reason
  from public.jobs j
  where j.queue = 'fast'
  order by j.created_at desc
  limit 20;
end;
$$;

grant execute on function public.debug_fast_queue_jobs() to authenticated;

-- 2. Test lease function directly
create or replace function public.test_lease_fast_job()
returns table(
  leased_job_id uuid,
  leased_job_type text,
  leased_job_status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_lease_until timestamptz := v_now + interval '1 minute';
  v_job public.jobs;
begin
  -- Try to lease a fast queue job
  select * into v_job
  from public.lease_next_job(v_now, v_lease_until, 'fast');
  
  if v_job.id is not null then
    leased_job_id := v_job.id;
    leased_job_type := v_job.type;
    leased_job_status := v_job.status;
    return next;
  else
    leased_job_id := null;
    leased_job_type := 'NO JOB FOUND';
    leased_job_status := 'NO JOB FOUND';
    return next;
  end if;
end;
$$;

grant execute on function public.test_lease_fast_job() to authenticated;

-- Example usage:
-- SELECT * FROM public.debug_fast_queue_jobs();  -- See all fast queue jobs and why they're not leasable
-- SELECT * FROM public.test_lease_fast_job();    -- Try to lease a fast job (will actually lease it!)







