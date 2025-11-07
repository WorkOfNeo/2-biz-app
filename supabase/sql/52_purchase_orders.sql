-- Purchase Orders table
create table if not exists public.purchase_orders (
  id bigserial primary key,
  po_no text not null,
  status text check (status in ('Running','Shipped')) not null default 'Running',
  supplier text,
  styles integer,
  ordered integer,
  shipped integer,
  etd text,
  eta text,
  purchaser text,
  po_link text,
  pdf_link text,
  excel_link text,
  meta jsonb,
  scraped_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (po_no)
);

alter table if exists public.purchase_orders enable row level security;

-- Basic policy: allow authenticated users to read
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_orders' and policyname = 'allow authenticated read purchase_orders'
  ) then
    create policy "allow authenticated read purchase_orders"
      on public.purchase_orders for select
      to authenticated
      using (true);
  end if;
end $$;

-- Helpful indexes
create index if not exists idx_purchase_orders_status on public.purchase_orders (status);
create index if not exists idx_purchase_orders_po_no on public.purchase_orders (po_no);
create index if not exists idx_purchase_orders_updated_at on public.purchase_orders (updated_at desc);

-- Trigger to keep updated_at current
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists set_timestamp_purchase_orders on public.purchase_orders;
create trigger set_timestamp_purchase_orders
before update on public.purchase_orders
for each row execute procedure public.set_updated_at();


