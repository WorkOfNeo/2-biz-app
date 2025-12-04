-- 82_jobs_insert_policy_anon.sql
-- Allow both authenticated and anon users to insert jobs
-- This is needed for the /api/enqueue route when called from client-side

drop policy if exists jobs_insert_auth on public.jobs;
create policy jobs_insert_auth on public.jobs
for insert
to authenticated, anon
with check (true);

