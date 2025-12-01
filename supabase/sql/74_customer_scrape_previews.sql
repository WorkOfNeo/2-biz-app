-- 74_customer_scrape_previews.sql
-- Store scraped customer data before applying to customers table

create table if not exists public.customer_scrape_previews (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete cascade,
  scraped_data jsonb not null,
  diff_data jsonb not null,
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

-- Index for quick lookup by job_id
create index if not exists customer_scrape_previews_job_id_idx 
  on public.customer_scrape_previews(job_id);

-- Index for unapplied previews
create index if not exists customer_scrape_previews_applied_at_idx 
  on public.customer_scrape_previews(applied_at) 
  where applied_at is null;

-- RLS policies
alter table public.customer_scrape_previews enable row level security;

drop policy if exists customer_scrape_previews_select_all on public.customer_scrape_previews;
create policy customer_scrape_previews_select_all 
  on public.customer_scrape_previews 
  for select to public using (true);

drop policy if exists customer_scrape_previews_insert_authenticated on public.customer_scrape_previews;
create policy customer_scrape_previews_insert_authenticated 
  on public.customer_scrape_previews 
  for insert to authenticated with check (true);

drop policy if exists customer_scrape_previews_update_authenticated on public.customer_scrape_previews;
create policy customer_scrape_previews_update_authenticated 
  on public.customer_scrape_previews 
  for update to authenticated using (true);

