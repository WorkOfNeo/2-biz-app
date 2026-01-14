-- 124_purchase_ai_runs_nullable_ai_run.sql
-- Allow ai_run_id to be NULL so we can create the purchase_ai_runs record 
-- before the worker creates the ai_runs record

-- Drop the NOT NULL constraint on ai_run_id
alter table public.purchase_ai_runs
  alter column ai_run_id drop not null;

-- Add a job_id column to track the processing job
alter table public.purchase_ai_runs
  add column if not exists job_id uuid;

-- Add index for job lookup
create index if not exists idx_purchase_ai_runs_job_id on public.purchase_ai_runs(job_id);
