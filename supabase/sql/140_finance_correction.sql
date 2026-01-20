-- 140_finance_correction.sql
-- Finance CORRECTION feature: store uploaded XLSX runs and enriched output rows

-- =============================================================================
-- 1. FINANCE_CORRECTION_RUNS TABLE (one per file upload)
-- =============================================================================
create table if not exists public.finance_correction_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid(),
  file_name text,
  style_no text not null,
  file_customs_tariff text, -- value from C2 of uploaded file, for trace
  -- Snapshot of style metadata at time of upload
  style_name text,
  cost_price numeric(12, 2),
  cost_price_currency text,
  customs_tariff_no text,
  country_of_origin text,
  row_count int not null default 0
);

create index if not exists idx_finance_correction_runs_created_at on public.finance_correction_runs(created_at desc);
create index if not exists idx_finance_correction_runs_style_no on public.finance_correction_runs(style_no);

-- =============================================================================
-- 2. FINANCE_CORRECTION_ROWS TABLE (output rows per run)
-- =============================================================================
create table if not exists public.finance_correction_rows (
  id bigserial primary key,
  run_id uuid not null references public.finance_correction_runs(id) on delete cascade,
  row_no int not null, -- source row index (1-based)
  -- Output columns (stored so re-download does not require recompute)
  toldref text,
  varenr text,
  varenavn text,
  pris numeric(12, 2),
  valuta_original text,
  toldtariff text,
  oprindelsesland text,
  ny_toldlager text,
  dato date,
  day int,
  month int,
  year int,
  reference text,
  ind_ud text,
  eksport_ref text,
  eksport_til text,
  antal int,
  vaerdi numeric(14, 2),
  valuta text,
  kurs text,
  total_dkk_vaerdi text,
  frafoerselsref text,
  non_eu text
);

create index if not exists idx_finance_correction_rows_run_id on public.finance_correction_rows(run_id);

-- =============================================================================
-- 3. RLS POLICIES
-- =============================================================================
alter table if exists public.finance_correction_runs enable row level security;
alter table if exists public.finance_correction_rows enable row level security;

-- finance_correction_runs policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_runs' and policyname = 'Allow authenticated read access to finance_correction_runs'
  ) then
    create policy "Allow authenticated read access to finance_correction_runs"
      on public.finance_correction_runs for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_runs' and policyname = 'Allow authenticated insert access to finance_correction_runs'
  ) then
    create policy "Allow authenticated insert access to finance_correction_runs"
      on public.finance_correction_runs for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_runs' and policyname = 'Allow authenticated update access to finance_correction_runs'
  ) then
    create policy "Allow authenticated update access to finance_correction_runs"
      on public.finance_correction_runs for update
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_runs' and policyname = 'Allow authenticated delete access to finance_correction_runs'
  ) then
    create policy "Allow authenticated delete access to finance_correction_runs"
      on public.finance_correction_runs for delete
      to authenticated
      using (true);
  end if;
end $$;

-- finance_correction_rows policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_rows' and policyname = 'Allow authenticated read access to finance_correction_rows'
  ) then
    create policy "Allow authenticated read access to finance_correction_rows"
      on public.finance_correction_rows for select
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_rows' and policyname = 'Allow authenticated insert access to finance_correction_rows'
  ) then
    create policy "Allow authenticated insert access to finance_correction_rows"
      on public.finance_correction_rows for insert
      to authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_rows' and policyname = 'Allow authenticated update access to finance_correction_rows'
  ) then
    create policy "Allow authenticated update access to finance_correction_rows"
      on public.finance_correction_rows for update
      to authenticated
      using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'finance_correction_rows' and policyname = 'Allow authenticated delete access to finance_correction_rows'
  ) then
    create policy "Allow authenticated delete access to finance_correction_rows"
      on public.finance_correction_rows for delete
      to authenticated
      using (true);
  end if;
end $$;
