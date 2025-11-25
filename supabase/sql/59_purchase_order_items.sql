-- Add category to purchase_orders (if missing) and items table for PO lines
alter table if exists public.purchase_orders
  add column if not exists category text;

create table if not exists public.purchase_order_items (
  id bigserial primary key,
  po_no text not null,
  style_no text,
  style_name text,
  color text,
  qty integer,
  style_link text,
  scraped_at timestamptz not null default now()
);

create index if not exists idx_purchase_order_items_po_no on public.purchase_order_items (po_no);

-- Optional: simple RLS allowing authenticated read
alter table if exists public.purchase_order_items enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_order_items' and policyname = 'allow authenticated read purchase_order_items'
  ) then
    create policy "allow authenticated read purchase_order_items"
      on public.purchase_order_items for select
      to authenticated
      using (true);
  end if;
end $$;


