-- 97_vendor_statistics.sql
-- Tables for Top 10 Vendors statistics with collections, vendors, and styles

-- =============================================================================
-- 1. VENDOR COLLECTIONS TABLE (tabs/seasons)
-- =============================================================================
create table if not exists public.vendor_collections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  season_id uuid references public.seasons(id) on delete set null,
  sort_order integer not null default 0,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vendor_collections_created_by on public.vendor_collections(created_by);
create index if not exists idx_vendor_collections_season_id on public.vendor_collections(season_id);
create index if not exists idx_vendor_collections_sort_order on public.vendor_collections(sort_order);

-- =============================================================================
-- 2. VENDOR ROWS TABLE (vendors within collections)
-- =============================================================================
create table if not exists public.vendor_rows (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.vendor_collections(id) on delete cascade,
  leverandør text not null, -- Supplier name
  antal_prøver numeric not null default 0, -- Number of samples
  styles_i_koll numeric not null default 0, -- Styles in collection
  gns_pris_pr_prøve numeric not null default 0, -- Average price per sample (DKK)
  total numeric not null default 0, -- Total (calculated)
  total_ubrugte numeric not null default 0, -- Total unused
  diff numeric not null default 0, -- Difference (calculated)
  prøvefaktor numeric not null default 0, -- Sample factor (calculated or manual)
  currency text not null default 'DKK' check (currency in ('DKK', 'EUR', 'USD')),
  exchange_rate numeric not null default 1, -- Exchange rate to DKK
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vendor_rows_collection_id on public.vendor_rows(collection_id);
create index if not exists idx_vendor_rows_sort_order on public.vendor_rows(collection_id, sort_order);

-- =============================================================================
-- 3. VENDOR STYLES TABLE (styles within vendors)
-- =============================================================================
create table if not exists public.vendor_styles (
  id uuid primary key default gen_random_uuid(),
  vendor_row_id uuid not null references public.vendor_rows(id) on delete cascade,
  style_no text not null, -- Matched style_no from database
  original_input text, -- Original input (style name or number)
  price_per_sample numeric not null default 0,
  out_of_collection boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_vendor_styles_vendor_row_id on public.vendor_styles(vendor_row_id);
create index if not exists idx_vendor_styles_style_no on public.vendor_styles(style_no);
create index if not exists idx_vendor_styles_sort_order on public.vendor_styles(vendor_row_id, sort_order);

-- =============================================================================
-- UPDATED_AT TRIGGERS
-- =============================================================================
-- Reuse existing set_updated_at function if it exists, otherwise create it
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_vendor_collections_updated_at on public.vendor_collections;
create trigger trg_vendor_collections_updated_at before update on public.vendor_collections
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_vendor_rows_updated_at on public.vendor_rows;
create trigger trg_vendor_rows_updated_at before update on public.vendor_rows
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_vendor_styles_updated_at on public.vendor_styles;
create trigger trg_vendor_styles_updated_at before update on public.vendor_styles
for each row execute procedure public.set_updated_at();

-- =============================================================================
-- RLS POLICIES
-- =============================================================================
alter table if exists public.vendor_collections enable row level security;
alter table if exists public.vendor_rows enable row level security;
alter table if exists public.vendor_styles enable row level security;

-- Vendor Collections policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_collections' and policyname = 'allow authenticated read vendor_collections'
  ) then
    create policy "allow authenticated read vendor_collections"
      on public.vendor_collections for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_collections' and policyname = 'allow authenticated write vendor_collections'
  ) then
    create policy "allow authenticated write vendor_collections"
      on public.vendor_collections for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- Vendor Rows policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_rows' and policyname = 'allow authenticated read vendor_rows'
  ) then
    create policy "allow authenticated read vendor_rows"
      on public.vendor_rows for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_rows' and policyname = 'allow authenticated write vendor_rows'
  ) then
    create policy "allow authenticated write vendor_rows"
      on public.vendor_rows for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- Vendor Styles policies
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_styles' and policyname = 'allow authenticated read vendor_styles'
  ) then
    create policy "allow authenticated read vendor_styles"
      on public.vendor_styles for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'vendor_styles' and policyname = 'allow authenticated write vendor_styles'
  ) then
    create policy "allow authenticated write vendor_styles"
      on public.vendor_styles for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;








