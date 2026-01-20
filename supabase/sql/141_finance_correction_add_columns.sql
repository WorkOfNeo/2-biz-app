-- 141_finance_correction_add_columns.sql
-- Add toldref, first_date, last_date columns to finance_correction_runs
-- These are used for better identification of runs in the UI

alter table if exists public.finance_correction_runs
  add column if not exists toldref text;

alter table if exists public.finance_correction_runs
  add column if not exists first_date date;

alter table if exists public.finance_correction_runs
  add column if not exists last_date date;

comment on column public.finance_correction_runs.toldref is 'First toldref value from the uploaded data rows';
comment on column public.finance_correction_runs.first_date is 'Earliest transaction date from the uploaded data';
comment on column public.finance_correction_runs.last_date is 'Latest transaction date from the uploaded data';
