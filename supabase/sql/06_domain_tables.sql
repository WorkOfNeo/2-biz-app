-- 06_domain_tables.sql
-- Core domain tables: customers, salespersons, seasons, season_statistics

create table if not exists public.salespersons (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null unique,
  company text,
  stats_display_name text,
  group_name text,
  salesperson_id uuid references public.salespersons(id) on delete set null,
  email text,
  city text,
  postal text,
  country text,
  currency text,
  excluded boolean not null default false,
  nulled boolean not null default false,
  permanently_closed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.season_statistics (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete cascade,
  qty numeric not null default 0,
  amount numeric not null default 0,
  currency text,
  created_at timestamptz not null default now(),
  unique(customer_id, season_id)
);

-- Reuse updated_at trigger for tables that have it
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_salespersons_updated_at on public.salespersons;
create trigger trg_salespersons_updated_at before update on public.salespersons
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_customers_updated_at on public.customers;
create trigger trg_customers_updated_at before update on public.customers
for each row execute procedure public.set_updated_at();


