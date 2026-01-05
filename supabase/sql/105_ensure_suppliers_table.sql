-- 105_ensure_suppliers_table.sql
-- Ensures the suppliers table exists (safe to run multiple times)

-- =============================================================================
-- SUPPLIERS TABLE
-- =============================================================================
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  external_name text, -- matches supplier name from other databases
  spy_id text, -- SPY system ID, manually entered
  lead_time_days integer default 0,
  travel_time_days integer default 0,
  moq integer default 0, -- minimum order quantity
  tags text[] default '{}', -- e.g., ['BELL_RAIN'] for pull-first suppliers
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create unique index if not exists
create unique index if not exists uq_suppliers_name on public.suppliers(name);
create index if not exists idx_suppliers_active on public.suppliers(active) where active = true;

-- RLS
alter table if exists public.suppliers enable row level security;

-- Drop and recreate policies to ensure they exist
drop policy if exists "allow authenticated read suppliers" on public.suppliers;
create policy "allow authenticated read suppliers"
  on public.suppliers for select
  to authenticated
  using (true);

drop policy if exists "allow authenticated write suppliers" on public.suppliers;
create policy "allow authenticated write suppliers"
  on public.suppliers for all
  to authenticated
  using (true)
  with check (true);

-- Trigger for updated_at
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_timestamp_suppliers on public.suppliers;
create trigger set_timestamp_suppliers
before update on public.suppliers
for each row execute procedure public.set_updated_at();

-- Seed a sample supplier
insert into public.suppliers (name, tags, notes)
values ('BELL_RAIN', array['BELL_RAIN'], 'Secondary storage - pull stock first before buying new')
on conflict (name) do nothing;

