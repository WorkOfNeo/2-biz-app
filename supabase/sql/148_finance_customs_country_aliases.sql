-- 148_finance_customs_country_aliases.sql
-- Country shorthand mapping for customs/finance (e.g. China -> CN)

create table if not exists public.finance_customs_country_aliases (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  name text not null,
  name_norm text generated always as (lower(trim(name))) stored,
  code text not null
);

-- One alias per normalized name
do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'finance_customs_country_aliases_unique_name_norm'
  ) then
    alter table public.finance_customs_country_aliases
      add constraint finance_customs_country_aliases_unique_name_norm
      unique (name_norm);
  end if;
end $$;

create index if not exists idx_fin_customs_country_aliases_code
  on public.finance_customs_country_aliases(code);

comment on table public.finance_customs_country_aliases is 'Country shorthand mapping for customs/finance (e.g. China -> CN).';

-- Defaults (safe to re-run)
insert into public.finance_customs_country_aliases (name, code)
values
  ('China', 'CN'),
  ('Vietnam', 'VN'),
  ('Turkey', 'TR'),
  ('Bangladesh', 'BD'),
  ('India', 'IN'),
  ('Pakistan', 'PK'),
  ('Cambodia', 'KH'),
  ('Portugal', 'PT'),
  ('Italy', 'IT'),
  ('France', 'FR'),
  ('Germany', 'DE'),
  ('Denmark', 'DK'),
  ('Sweden', 'SE'),
  ('Norway', 'NO'),
  ('United Kingdom', 'GB'),
  ('UK', 'GB'),
  ('United States', 'US'),
  ('USA', 'US'),
  ('Netherlands', 'NL'),
  ('Spain', 'ES'),
  ('Poland', 'PL')
on conflict (name_norm) do update set code = excluded.code;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table if exists public.finance_customs_country_aliases enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_country_aliases' and policyname = 'Allow authenticated read access to finance_customs_country_aliases'
  ) then
    create policy "Allow authenticated read access to finance_customs_country_aliases"
      on public.finance_customs_country_aliases for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_country_aliases' and policyname = 'Allow authenticated insert access to finance_customs_country_aliases'
  ) then
    create policy "Allow authenticated insert access to finance_customs_country_aliases"
      on public.finance_customs_country_aliases for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_country_aliases' and policyname = 'Allow authenticated update access to finance_customs_country_aliases'
  ) then
    create policy "Allow authenticated update access to finance_customs_country_aliases"
      on public.finance_customs_country_aliases for update
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_customs_country_aliases' and policyname = 'Allow authenticated delete access to finance_customs_country_aliases'
  ) then
    create policy "Allow authenticated delete access to finance_customs_country_aliases"
      on public.finance_customs_country_aliases for delete
      to authenticated
      using (true);
  end if;
end $$;

