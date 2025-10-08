-- 01_tables.sql
-- Tables for jobs, job_logs, and job_results

create extension if not exists pgcrypto;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('scrape_statistics')),
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 3,
  lease_until timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.job_logs (
  id bigserial primary key,
  job_id uuid references public.jobs(id) on delete cascade,
  ts timestamptz not null default now(),
  level text not null default 'info',
  msg text not null,
  data jsonb
);

create table if not exists public.job_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete cascade,
  summary text,
  data jsonb,
  created_at timestamptz not null default now()
);

-- trigger to set jobs.updated_at on update
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_jobs_updated_at on public.jobs;
create trigger trg_jobs_updated_at
before update on public.jobs
for each row execute procedure public.set_updated_at();


