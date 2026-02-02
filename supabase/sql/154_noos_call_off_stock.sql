-- 154_noos_call_off_stock.sql
-- Create dedicated table for NOOS Call Off stock scraping results
-- Separate from style_stock to avoid interference with main stock tracking

create table if not exists public.noos_call_off_stock (
  id uuid primary key default gen_random_uuid(),
  style_no text not null,
  color text not null,
  sizes jsonb not null default '[]'::jsonb, -- array of size labels in column order
  section text not null, -- 'Stock' | 'Sold' | 'Available' | 'PO Available' | 'Purchase (Running + Shipped)' | etc.
  row_label text not null default '', -- e.g., 'Stock', 'Delivered', '25 WINTER', '10 PCS', 'BR7225' (normalized to empty string, never null)
  values jsonb not null default '[]'::jsonb, -- numeric array across sizes plus total if present
  po_link text, -- href when present on purchase rows
  scraped_at timestamptz not null default now(),
  job_id uuid -- reference to the job that created this data
);

create index if not exists idx_noos_call_off_stock_style_no on public.noos_call_off_stock(style_no);
create index if not exists idx_noos_call_off_stock_job_id on public.noos_call_off_stock(job_id);
create index if not exists idx_noos_call_off_stock_scraped_at on public.noos_call_off_stock(scraped_at desc);

-- Ensure one row per (style_no, color, section, row_label) logical key
-- Worker normalizes null to empty string before insert, so we can use a simple constraint
alter table public.noos_call_off_stock 
  add constraint uq_noos_call_off_stock_key 
  unique (style_no, color, section, row_label);

-- RLS: Allow authenticated users to read/write
alter table if exists public.noos_call_off_stock enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'noos_call_off_stock' and policyname = 'allow authenticated read noos_call_off_stock'
  ) then
    create policy "allow authenticated read noos_call_off_stock"
      on public.noos_call_off_stock for select
      to authenticated
      using (true);
  end if;
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'noos_call_off_stock' and policyname = 'allow authenticated write noos_call_off_stock'
  ) then
    create policy "allow authenticated write noos_call_off_stock"
      on public.noos_call_off_stock for all
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;
