-- 101_check_job_type_constraint.sql
-- Diagnostic query to check if scrape_style_raw_costs is in the jobs.type check constraint

-- Check the current constraint definition
SELECT 
  conname as constraint_name,
  pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'public.jobs'::regclass
  AND conname = 'jobs_type_check';

-- Check if scrape_style_raw_costs jobs exist
SELECT 
  id,
  type,
  status,
  queue,
  created_at,
  lease_until,
  error
FROM public.jobs
WHERE type = 'scrape_style_raw_costs'
ORDER BY created_at DESC
LIMIT 10;

-- Check recent jobs to see what types are being created
SELECT 
  type,
  queue,
  status,
  COUNT(*) as count,
  MAX(created_at) as latest
FROM public.jobs
WHERE created_at > now() - interval '7 days'
GROUP BY type, queue, status
ORDER BY latest DESC;






