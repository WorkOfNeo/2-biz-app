-- 111_suppliers_usual_delivery_weekday.sql
-- Add a per-supplier preferred delivery weekday for ETA snapping

alter table if exists public.suppliers
  add column if not exists usual_delivery_weekday integer;

-- 0=Sunday .. 6=Saturday (JS Date.getDay)
alter table if exists public.suppliers
  drop constraint if exists suppliers_usual_delivery_weekday_range;

alter table if exists public.suppliers
  add constraint suppliers_usual_delivery_weekday_range
  check (usual_delivery_weekday is null or (usual_delivery_weekday >= 0 and usual_delivery_weekday <= 6));


