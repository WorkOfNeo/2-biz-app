-- 88_supp_statistic_add_salesperson_id.sql
-- Add salesperson_id columns and link existing records to salespersons table
-- This script will:
-- 1. Add salesperson_id columns to both tables
-- 2. Match existing records by salesperson_name
-- 3. Create triggers to auto-populate salesperson_id for future inserts

-- 1. Add salesperson_id column to supp_statistic
alter table if exists public.supp_statistic
  add column if not exists salesperson_id uuid references public.salespersons(id) on delete set null;

-- 2. Add salesperson_id column to supp_statistic_rows
alter table if exists public.supp_statistic_rows
  add column if not exists salesperson_id uuid references public.salespersons(id) on delete set null;

-- 3. Update existing records in supp_statistic by matching salesperson_name to salespersons.name
update public.supp_statistic s
set salesperson_id = sp.id
from public.salespersons sp
where s.salesperson_name = sp.name
  and s.salesperson_id is null;

-- 4. Update existing records in supp_statistic_rows by matching salesperson_name to salespersons.name
update public.supp_statistic_rows s
set salesperson_id = sp.id
from public.salespersons sp
where s.salesperson_name = sp.name
  and s.salesperson_id is null;

-- 5. Create indexes for the new columns
create index if not exists idx_supp_statistic_salesperson_id on public.supp_statistic(salesperson_id);
create index if not exists idx_supp_statistic_rows_salesperson_id on public.supp_statistic_rows(salesperson_id);

-- 6. Create a function to auto-populate salesperson_id from salesperson_name on insert/update
create or replace function public.set_supp_salesperson_id()
returns trigger language plpgsql as $$
begin
  -- If salesperson_id is not set but salesperson_name is, try to find and set it
  if new.salesperson_id is null and new.salesperson_name is not null then
    select id into new.salesperson_id
    from public.salespersons
    where name = new.salesperson_name
    limit 1;
  end if;
  return new;
end;
$$;

-- 7. Create triggers to auto-populate salesperson_id
drop trigger if exists trg_supp_statistic_set_salesperson_id on public.supp_statistic;
create trigger trg_supp_statistic_set_salesperson_id
  before insert or update on public.supp_statistic
  for each row execute procedure public.set_supp_salesperson_id();

drop trigger if exists trg_supp_statistic_rows_set_salesperson_id on public.supp_statistic_rows;
create trigger trg_supp_statistic_rows_set_salesperson_id
  before insert or update on public.supp_statistic_rows
  for each row execute procedure public.set_supp_salesperson_id();

-- 8. Report unmatched salesperson names (for manual review)
-- This query will show salesperson names that don't match any salesperson in the database
do $$
declare
  unmatched_stat_count int;
  unmatched_rows_count int;
begin
  select count(distinct s.salesperson_name) into unmatched_stat_count
  from public.supp_statistic s
  left join public.salespersons sp on s.salesperson_name = sp.name
  where s.salesperson_id is null
    and sp.id is null;

  select count(distinct s.salesperson_name) into unmatched_rows_count
  from public.supp_statistic_rows s
  left join public.salespersons sp on s.salesperson_name = sp.name
  where s.salesperson_id is null
    and sp.id is null;

  raise notice 'Unmatched salesperson names in supp_statistic: %', unmatched_stat_count;
  raise notice 'Unmatched salesperson names in supp_statistic_rows: %', unmatched_rows_count;
end;
$$;

