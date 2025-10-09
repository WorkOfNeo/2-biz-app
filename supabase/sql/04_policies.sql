-- 04_policies.sql
-- Anon (web) can SELECT; service role bypasses RLS by default

-- jobs: allow read for all authenticated/anon (as per anon key usage). If you prefer, scope to anon role.
drop policy if exists jobs_select_all on public.jobs;
create policy jobs_select_all on public.jobs
for select
to public
using (true);

-- job_logs: allow read
drop policy if exists job_logs_select_all on public.job_logs;
create policy job_logs_select_all on public.job_logs
for select
to public
using (true);

-- job_results: allow read
drop policy if exists job_results_select_all on public.job_results;
create policy job_results_select_all on public.job_results
for select
to public
using (true);

-- No insert/update/delete allowed for anon/public, so no policies for those.


-- salespersons policies: allow select for all, update for authenticated users
drop policy if exists salespersons_select_all on public.salespersons;
create policy salespersons_select_all on public.salespersons
for select
to public
using (true);

drop policy if exists salespersons_update_auth on public.salespersons;
create policy salespersons_update_auth on public.salespersons
for update
to authenticated
using (true)
with check (true);


