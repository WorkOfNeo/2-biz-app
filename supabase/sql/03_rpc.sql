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


-- Delete a salesperson, optionally deleting associated customers as well
-- Note: season_statistics has ON DELETE CASCADE via customers; sales_stats references are nulled
create or replace function public.delete_salesperson(p_salesperson_id uuid, p_delete_customers boolean default false)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_delete_customers then
    delete from public.customers where salesperson_id = p_salesperson_id;
  else
    update public.customers set salesperson_id = null where salesperson_id = p_salesperson_id;
  end if;

  -- Clean up loose references in raw sales stats
  update public.sales_stats
  set salesperson_id = null,
      salesperson_name = null
  where salesperson_id = p_salesperson_id;

  delete from public.salespersons where id = p_salesperson_id;
end;
$$;

grant execute on function public.delete_salesperson(uuid, boolean) to public;

