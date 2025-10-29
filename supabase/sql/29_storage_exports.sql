-- 29_storage_exports.sql
-- Create a public Storage bucket for exports and allow public read

-- Create bucket if it doesn't exist
insert into storage.buckets (id, name, public)
select 'exports', 'exports', true
where not exists (select 1 from storage.buckets where id = 'exports');

-- Enable RLS on objects (required by Supabase Storage)
alter table if exists storage.objects enable row level security;

-- Allow public read access to files in the exports bucket
drop policy if exists exports_public_read on storage.objects;
create policy exports_public_read on storage.objects
  for select
  using (bucket_id = 'exports');

-- (Optional) Allow authenticated uploads to exports bucket
-- The worker uses service role and bypasses RLS, so this is not required for it
-- drop policy if exists exports_authenticated_write on storage.objects;
-- create policy exports_authenticated_write on storage.objects
--   for insert to authenticated
--   with check (bucket_id = 'exports');


