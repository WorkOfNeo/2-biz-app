-- 03_rpc.sql
-- Function lease_next_job(p_now timestamptz, p_lease_until timestamptz) returns jobs

create or replace function public.lease_next_job(p_now timestamptz, p_lease_until timestamptz)
returns public.jobs
language plpgsql
as $$
declare
  v_job public.jobs;
begin
  select * into v_job
  from public.jobs
  where (
      status = 'queued'
      or (status = 'running' and (lease_until is null or lease_until < p_now))
    )
  order by created_at asc
  for update skip locked
  limit 1;

  if not found then
    return null;
  end if;

  update public.jobs j
  set status = 'running',
      lease_until = p_lease_until,
      started_at = coalesce(j.started_at, p_now),
      attempts = j.attempts + 1
  where j.id = v_job.id
  returning * into v_job;

  return v_job;
end;
$$;


