-- 10_seasons_write_policy.sql
-- Allow authenticated users to INSERT into seasons directly from the browser

-- Ensure RLS is enabled (already enabled in 07_domain_rls.sql)
-- alter table public.seasons enable row level security;

-- Allow INSERTs for authenticated users
drop policy if exists seasons_insert_authenticated on public.seasons;
create policy seasons_insert_authenticated on public.seasons
for insert
to authenticated
with check (true);


