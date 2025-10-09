-- 12_season_statistics_write_policy.sql
-- Allow authenticated users to insert/update season_statistics from the browser

-- insert
drop policy if exists season_statistics_insert_authenticated on public.season_statistics;
create policy season_statistics_insert_authenticated on public.season_statistics
for insert
to authenticated
with check (true);

-- update
drop policy if exists season_statistics_update_authenticated on public.season_statistics;
create policy season_statistics_update_authenticated on public.season_statistics
for update
to authenticated
using (true)
with check (true);


