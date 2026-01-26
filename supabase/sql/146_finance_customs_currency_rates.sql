-- 146_finance_customs_currency_rates.sql
-- Global (non-season) currency rates for Finance/Customs, stored per month

create table if not exists public.finance_customs_currency_rates (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  currency_code text not null,
  year int not null,
  month int not null,
  rate_dkk numeric(12, 4) not null
);

-- One rate per currency per month
do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'finance_customs_currency_rates_unique_currency_month'
  ) then
    alter table public.finance_customs_currency_rates
      add constraint finance_customs_currency_rates_unique_currency_month
      unique (currency_code, year, month);
  end if;
end $$;

create index if not exists idx_fin_customs_currency_rates_created_at
  on public.finance_customs_currency_rates(created_at desc);

create index if not exists idx_fin_customs_currency_rates_lookup
  on public.finance_customs_currency_rates(currency_code, year desc, month desc);

comment on table public.finance_customs_currency_rates is 'Manual currency conversion rates for customs/finance (DKK per 1 unit), stored per month.';
comment on column public.finance_customs_currency_rates.rate_dkk is 'DKK per 1 unit (e.g. 1 USD = X DKK).';

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table if exists public.finance_customs_currency_rates enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_currency_rates' and policyname = 'Allow authenticated read access to finance_customs_currency_rates'
  ) then
    create policy "Allow authenticated read access to finance_customs_currency_rates"
      on public.finance_customs_currency_rates for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_currency_rates' and policyname = 'Allow authenticated insert access to finance_customs_currency_rates'
  ) then
    create policy "Allow authenticated insert access to finance_customs_currency_rates"
      on public.finance_customs_currency_rates for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_currency_rates' and policyname = 'Allow authenticated update access to finance_customs_currency_rates'
  ) then
    create policy "Allow authenticated update access to finance_customs_currency_rates"
      on public.finance_customs_currency_rates for update
      to authenticated
      using (true);
  end if;
end $$;

