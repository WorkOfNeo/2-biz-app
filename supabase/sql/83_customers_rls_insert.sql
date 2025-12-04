-- 83_customers_rls_insert.sql
-- Add RLS policy to allow authenticated users to insert customers

-- Drop existing insert policy if it exists
drop policy if exists "Allow authenticated users to insert customers" on public.customers;

-- Create insert policy for authenticated users
create policy "Allow authenticated users to insert customers"
  on public.customers
  for insert
  to authenticated
  with check (true);

-- Also ensure we have update policy
drop policy if exists "Allow authenticated users to update customers" on public.customers;

create policy "Allow authenticated users to update customers"
  on public.customers
  for update
  to authenticated
  using (true)
  with check (true);

-- Verify RLS is enabled (should already be)
alter table public.customers enable row level security;

-- Show current policies for verification
do $$
begin
  raise notice 'RLS policies for customers table have been updated';
end $$;

