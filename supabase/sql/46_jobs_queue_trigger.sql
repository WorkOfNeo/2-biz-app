-- Enforce queue/priority at DB-level based on job type
create or replace function public.jobs_queue_enforce()
returns trigger
language plpgsql
as $$
begin
  -- Default queue/priority
  if new.queue is null or length(trim(new.queue)) = 0 then
    new.queue := 'default';
  end if;
  if new.priority is null then
    new.priority := 100;
  end if;

  -- Force stock jobs onto 'stock' queue with lower priority
  if new.type = 'update_style_stock' then
    new.queue := 'stock';
    new.priority := 200;
  end if;

  return new;
end $$;

drop trigger if exists trg_jobs_queue_enforce_ins on public.jobs;
create trigger trg_jobs_queue_enforce_ins
before insert on public.jobs
for each row
execute function public.jobs_queue_enforce();

drop trigger if exists trg_jobs_queue_enforce_upd on public.jobs;
create trigger trg_jobs_queue_enforce_upd
before update of type, queue, priority on public.jobs
for each row
execute function public.jobs_queue_enforce();


