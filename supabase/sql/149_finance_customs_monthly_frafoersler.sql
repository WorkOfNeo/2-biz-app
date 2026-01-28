-- 149_finance_customs_monthly_frafoersler.sql
-- Monthly customs "Toldref" mapping used by CORRECTION.
-- Applied to column "Eksport ref" when "Eksport til" is EU, based on row month.

create table if not exists public.finance_customs_monthly_frafoersler (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  year int not null check (year >= 2000 and year <= 2100),
  month int not null check (month >= 1 and month <= 12),
  toldref text not null
);

-- One mapping per month
do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'finance_customs_monthly_frafoersler_unique_year_month'
  ) then
    alter table public.finance_customs_monthly_frafoersler
      add constraint finance_customs_monthly_frafoersler_unique_year_month
      unique (year, month);
  end if;
end $$;

create index if not exists idx_fin_customs_monthly_frafoersler_year_month
  on public.finance_customs_monthly_frafoersler(year, month);

comment on table public.finance_customs_monthly_frafoersler is 'Monthly customs Toldref mapping for CORRECTION exports (applied when Eksport til is EU).';

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table if exists public.finance_customs_monthly_frafoersler enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_monthly_frafoersler' and policyname = 'Allow authenticated read access to finance_customs_monthly_frafoersler'
  ) then
    create policy "Allow authenticated read access to finance_customs_monthly_frafoersler"
      on public.finance_customs_monthly_frafoersler for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_monthly_frafoersler' and policyname = 'Allow authenticated insert access to finance_customs_monthly_frafoersler'
  ) then
    create policy "Allow authenticated insert access to finance_customs_monthly_frafoersler"
      on public.finance_customs_monthly_frafoersler for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_monthly_frafoersler' and policyname = 'Allow authenticated update access to finance_customs_monthly_frafoersler'
  ) then
    create policy "Allow authenticated update access to finance_customs_monthly_frafoersler"
      on public.finance_customs_monthly_frafoersler for update
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_monthly_frafoersler' and policyname = 'Allow authenticated delete access to finance_customs_monthly_frafoersler'
  ) then
    create policy "Allow authenticated delete access to finance_customs_monthly_frafoersler"
      on public.finance_customs_monthly_frafoersler for delete
      to authenticated
      using (true);
  end if;
end $$;

