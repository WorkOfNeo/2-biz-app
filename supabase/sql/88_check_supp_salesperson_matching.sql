-- 88_check_supp_salesperson_matching.sql
-- QUERY SCRIPT: Check salesperson name matching before running the migration
-- Run this FIRST to see what will be matched and what won't

-- 1. Show all unique salesperson names in supp_statistic and their potential matches
select 
  s.salesperson_name as "Salesperson Name in Stats",
  sp.id as "Salesperson ID",
  sp.name as "Matched Salesperson Name",
  case 
    when sp.id is not null then '✓ MATCHED'
    else '✗ NO MATCH'
  end as "Status",
  (select count(*) from public.supp_statistic where salesperson_name = s.salesperson_name) as "Records in supp_statistic"
from (
  select distinct salesperson_name 
  from public.supp_statistic
) s
left join public.salespersons sp on s.salesperson_name = sp.name
order by "Status", s.salesperson_name;

-- 2. Show all unique salesperson names in supp_statistic_rows and their potential matches
select 
  s.salesperson_name as "Salesperson Name in Rows",
  sp.id as "Salesperson ID",
  sp.name as "Matched Salesperson Name",
  case 
    when sp.id is not null then '✓ MATCHED'
    else '✗ NO MATCH'
  end as "Status",
  (select count(*) from public.supp_statistic_rows where salesperson_name = s.salesperson_name) as "Records in supp_statistic_rows"
from (
  select distinct salesperson_name 
  from public.supp_statistic_rows
) s
left join public.salespersons sp on s.salesperson_name = sp.name
order by "Status", s.salesperson_name;

-- 3. Show all salespersons that exist in the database (for reference)
select 
  id as "Salesperson ID",
  name as "Salesperson Name",
  (select count(*) from public.supp_statistic where salesperson_name = sp.name) as "Matching Stats",
  (select count(*) from public.supp_statistic_rows where salesperson_name = sp.name) as "Matching Rows"
from public.salespersons sp
order by sp.name;

-- 4. Summary: Count of matched vs unmatched
select 
  'supp_statistic' as "Table",
  count(*) as "Total Unique Names",
  count(sp.id) as "Matched",
  count(*) - count(sp.id) as "Unmatched"
from (
  select distinct salesperson_name 
  from public.supp_statistic
) s
left join public.salespersons sp on s.salesperson_name = sp.name
union all
select 
  'supp_statistic_rows' as "Table",
  count(*) as "Total Unique Names",
  count(sp.id) as "Matched",
  count(*) - count(sp.id) as "Unmatched"
from (
  select distinct salesperson_name 
  from public.supp_statistic_rows
) s
left join public.salespersons sp on s.salesperson_name = sp.name;

