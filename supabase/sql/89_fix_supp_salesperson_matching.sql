-- 89_fix_supp_salesperson_matching.sql
-- Fix salesperson_id matching to use case-insensitive comparison
-- This fixes the issue where XLSX names like "SØREN BOERIIS" don't match "Søren Boeriis" in the salespersons table

-- 1. Update the function to use case-insensitive matching (ilike) instead of exact match (=)
create or replace function public.set_supp_salesperson_id()
returns trigger language plpgsql as $$
begin
  -- If salesperson_id is not set but salesperson_name is, try to find and set it
  if new.salesperson_id is null and new.salesperson_name is not null then
    -- Use case-insensitive matching (ilike) for more reliable matching
    select id into new.salesperson_id
    from public.salespersons
    where lower(trim(name)) = lower(trim(new.salesperson_name))
    limit 1;
  end if;
  return new;
end;
$$;

-- 2. Update existing records in supp_statistic that don't have salesperson_id using case-insensitive match
update public.supp_statistic s
set salesperson_id = sp.id
from public.salespersons sp
where lower(trim(s.salesperson_name)) = lower(trim(sp.name))
  and s.salesperson_id is null;

-- 3. Update existing records in supp_statistic_rows that don't have salesperson_id using case-insensitive match
update public.supp_statistic_rows s
set salesperson_id = sp.id
from public.salespersons sp
where lower(trim(s.salesperson_name)) = lower(trim(sp.name))
  and s.salesperson_id is null;

-- 4. Report unmatched salesperson names (for manual review)
do $$
declare
  unmatched_stat_count int;
  unmatched_rows_count int;
  unmatched_names text[];
begin
  -- Count and list unmatched names in supp_statistic
  select count(distinct s.salesperson_name), array_agg(distinct s.salesperson_name)
  into unmatched_stat_count, unmatched_names
  from public.supp_statistic s
  where s.salesperson_id is null;

  if unmatched_stat_count > 0 then
    raise notice 'Unmatched salesperson names in supp_statistic: % - %', unmatched_stat_count, unmatched_names;
  else
    raise notice 'All salesperson names in supp_statistic are matched!';
  end if;

  -- Count unmatched names in supp_statistic_rows
  select count(distinct s.salesperson_name), array_agg(distinct s.salesperson_name)
  into unmatched_rows_count, unmatched_names
  from public.supp_statistic_rows s
  where s.salesperson_id is null;

  if unmatched_rows_count > 0 then
    raise notice 'Unmatched salesperson names in supp_statistic_rows: % - %', unmatched_rows_count, unmatched_names;
  else
    raise notice 'All salesperson names in supp_statistic_rows are matched!';
  end if;
end;
$$;






