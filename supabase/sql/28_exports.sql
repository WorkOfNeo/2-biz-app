-- 28_exports.sql
-- Stores generated export files (PDF/HTML) metadata

create table if not exists public.exports (
  id uuid primary key default gen_random_uuid(),
  kind text not null, -- e.g., 'countries_pdf', 'overview_pdf'
  title text,
  path text not null, -- storage path
  public_url text,
  meta jsonb,
  job_id uuid references public.jobs(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_exports_created_at on public.exports(created_at desc);

-- RLS: allow reads for all (app is authenticated) and writes via service role
alter table public.exports enable row level security;
drop policy if exists exports_select_all on public.exports;
create policy exports_select_all on public.exports
  for select using (true);


