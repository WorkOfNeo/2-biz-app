-- 30_statistics_per_size.sql
-- Snapshot and rows for SPY Statistics Per Size scrape

create table if not exists public.statistics_per_size_snapshots (
  id uuid primary key default gen_random_uuid(),
  date_from date not null,
  rows_count integer not null default 0,
  raw_tables_html text[] not null default '{}',
  scraped_at timestamptz not null default now()
);

create index if not exists idx_sps_snapshots_scraped_at on public.statistics_per_size_snapshots(scraped_at desc);

create table if not exists public.statistics_per_size_rows (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.statistics_per_size_snapshots(id) on delete cascade,
  style_no text not null,
  color text,
  style_name text,
  type text,
  sizes text[] not null,
  values integer[] not null,
  total integer not null default 0,
  min_col integer not null default 0,
  diff integer not null default 0
);

create index if not exists idx_sps_rows_snapshot on public.statistics_per_size_rows(snapshot_id);
create index if not exists idx_sps_rows_style_no on public.statistics_per_size_rows(style_no);

-- RLS: allow reads to authenticated users
alter table public.statistics_per_size_snapshots enable row level security;
alter table public.statistics_per_size_rows enable row level security;

drop policy if exists sps_snapshots_select_all on public.statistics_per_size_snapshots;
create policy sps_snapshots_select_all on public.statistics_per_size_snapshots for select using (true);

drop policy if exists sps_rows_select_all on public.statistics_per_size_rows;
create policy sps_rows_select_all on public.statistics_per_size_rows for select using (true);


