-- 15_sales_stats.sql
-- Raw, per-season statistics imported from legacy system

create table if not exists public.sales_stats (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  account_no text not null,
  customer_name text,
  city text,
  salesperson_id uuid references public.salespersons(id) on delete set null,
  salesperson_name text,
  qty numeric not null default 0,
  price numeric not null default 0,
  currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(season_id, account_no)
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_sales_stats_updated_at on public.sales_stats;
create trigger trg_sales_stats_updated_at before update on public.sales_stats
for each row execute procedure public.set_updated_at();


