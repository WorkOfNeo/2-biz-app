-- 61_historical_sales.sql
-- Store historical sales data per style, color, date, and size
-- Supports daily granularity with flexible upload (period data divided into daily records)

create table if not exists public.historical_sales (
  id uuid primary key default gen_random_uuid(),
  style_id uuid references public.styles(id) on delete cascade,
  style_no text not null,
  color text not null,
  date date not null,
  size text not null,
  quantity integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Indexes for efficient queries
create index if not exists idx_historical_sales_style_id on public.historical_sales(style_id);
create index if not exists idx_historical_sales_style_no_color on public.historical_sales(style_no, color);
create index if not exists idx_historical_sales_date on public.historical_sales(date);

-- Unique constraint: one record per style+color+date+size combination
create unique index if not exists uq_historical_sales_key on public.historical_sales(style_no, color, date, size);

-- RLS policies (match pattern from other tables)
alter table if exists public.historical_sales enable row level security;

do $$ begin
  -- Allow authenticated users to read
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'historical_sales' and policyname = 'Allow authenticated read access to historical_sales'
  ) then
    create policy "Allow authenticated read access to historical_sales"
      on public.historical_sales for select
      to authenticated
      using (true);
  end if;

  -- Allow authenticated users to insert
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'historical_sales' and policyname = 'Allow authenticated insert access to historical_sales'
  ) then
    create policy "Allow authenticated insert access to historical_sales"
      on public.historical_sales for insert
      to authenticated
      with check (true);
  end if;

  -- Allow authenticated users to update
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'historical_sales' and policyname = 'Allow authenticated update access to historical_sales'
  ) then
    create policy "Allow authenticated update access to historical_sales"
      on public.historical_sales for update
      to authenticated
      using (true);
  end if;

  -- Allow authenticated users to delete
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'historical_sales' and policyname = 'Allow authenticated delete access to historical_sales'
  ) then
    create policy "Allow authenticated delete access to historical_sales"
      on public.historical_sales for delete
      to authenticated
      using (true);
  end if;
end $$;

