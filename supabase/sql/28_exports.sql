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


-- User roles to gate features and pages
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  role text not null check (char_length(role) > 0),
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

-- Enable RLS and allow each user to read their own roles; service role can manage
alter table public.user_roles enable row level security;
drop policy if exists user_roles_select_own on public.user_roles;
create policy user_roles_select_own on public.user_roles
  for select using (auth.uid() = user_id);

-- Optional: allow the current user to see all roles (for admin UIs), can be tightened later
-- create policy user_roles_all on public.user_roles for select using (true);


