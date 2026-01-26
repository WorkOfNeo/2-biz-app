-- 144_finance_correction_export_no_sumups.sql
-- Finance CORRECTION: store "Export No." unique value summaries for quick lookup

create table if not exists public.finance_correction_export_no_sumups (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  file_name text,
  style_no text,
  export_nos text[] not null default '{}'::text[],
  export_no_count int not null default 0,
  export_nos_hash text
);

create index if not exists idx_fin_corr_export_no_sumups_created_at
  on public.finance_correction_export_no_sumups(created_at desc);

create index if not exists idx_fin_corr_export_no_sumups_style_no
  on public.finance_correction_export_no_sumups(style_no);

-- For fast "contains" lookups on export_nos array
create index if not exists idx_fin_corr_export_no_sumups_export_nos_gin
  on public.finance_correction_export_no_sumups using gin (export_nos);

-- Optional: prevent duplicate inserts for identical sets
do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'finance_correction_export_no_sumups_export_nos_hash_key'
  ) then
    alter table public.finance_correction_export_no_sumups
      add constraint finance_correction_export_no_sumups_export_nos_hash_key unique (export_nos_hash);
  end if;
end $$;

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table if exists public.finance_correction_export_no_sumups enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_export_no_sumups' and policyname = 'Allow authenticated read access to finance_correction_export_no_sumups'
  ) then
    create policy "Allow authenticated read access to finance_correction_export_no_sumups"
      on public.finance_correction_export_no_sumups for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_export_no_sumups' and policyname = 'Allow authenticated insert access to finance_correction_export_no_sumups'
  ) then
    create policy "Allow authenticated insert access to finance_correction_export_no_sumups"
      on public.finance_correction_export_no_sumups for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_export_no_sumups' and policyname = 'Allow authenticated delete access to finance_correction_export_no_sumups'
  ) then
    create policy "Allow authenticated delete access to finance_correction_export_no_sumups"
      on public.finance_correction_export_no_sumups for delete
      to authenticated
      using (true);
  end if;
end $$;

