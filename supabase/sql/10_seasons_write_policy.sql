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

-- Allow UPDATEs for authenticated users (UI edits: name, hidden, display_currency)
drop policy if exists seasons_update_authenticated on public.seasons;
create policy seasons_update_authenticated on public.seasons
for update
to authenticated
using (true)
with check (true);

-- Allow DELETEs for authenticated users (explicit confirmation in UI)
drop policy if exists seasons_delete_authenticated on public.seasons;
create policy seasons_delete_authenticated on public.seasons
for delete
to authenticated
using (true);


