-- 113_sales_style_details_scraped.sql
-- Tracks which customers have had style details scraped (per season)
-- first_scraped_at is immutable - records when we first collected data for AI purchasing decisions

create table if not exists public.sales_style_details_scraped (
  id uuid primary key default gen_random_uuid(),
  season_id uuid not null references public.seasons(id) on delete cascade,
  account_no text not null,
  first_scraped_at timestamptz not null default now(),
  -- If true, force re-scrape on next run (set from frontend)
  force_rescrape boolean not null default false,
  
  constraint unique_season_account unique (season_id, account_no)
);

-- Index for fast lookup
create index if not exists idx_sales_style_details_scraped_season on public.sales_style_details_scraped(season_id);

-- Enable RLS
alter table public.sales_style_details_scraped enable row level security;

-- RLS policies
drop policy if exists sales_style_details_scraped_select_all on public.sales_style_details_scraped;
create policy sales_style_details_scraped_select_all on public.sales_style_details_scraped for select to public using (true);

drop policy if exists sales_style_details_scraped_insert_authenticated on public.sales_style_details_scraped;
create policy sales_style_details_scraped_insert_authenticated on public.sales_style_details_scraped for insert to authenticated with check (true);

drop policy if exists sales_style_details_scraped_update_authenticated on public.sales_style_details_scraped;
create policy sales_style_details_scraped_update_authenticated on public.sales_style_details_scraped for update to authenticated using (true) with check (true);

drop policy if exists sales_style_details_scraped_delete_authenticated on public.sales_style_details_scraped;
create policy sales_style_details_scraped_delete_authenticated on public.sales_style_details_scraped for delete to authenticated using (true);
