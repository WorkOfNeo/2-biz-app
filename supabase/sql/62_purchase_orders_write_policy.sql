-- Add write policies for purchase_orders to allow app-created POs

-- Allow authenticated users to insert purchase orders
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_orders' and policyname = 'allow authenticated insert purchase_orders'
  ) then
    create policy "allow authenticated insert purchase_orders"
      on public.purchase_orders for insert
      to authenticated
      with check (true);
  end if;
end $$;

-- Allow authenticated users to update purchase orders
do $$ begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'purchase_orders' and policyname = 'allow authenticated update purchase_orders'
  ) then
    create policy "allow authenticated update purchase_orders"
      on public.purchase_orders for update
      to authenticated
      using (true)
      with check (true);
  end if;
end $$;

-- Add index for category field (added in 59_purchase_order_items.sql)
create index if not exists idx_purchase_orders_category on public.purchase_orders (category);

