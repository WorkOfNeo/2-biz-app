-- 57_stock_lists_sort.sql
-- Add sort preference to stock lists

alter table public.stock_lists
  add column if not exists sort_by text check (sort_by in ('style_no', 'style_name')) default 'style_no';

-- Keep existing rows defaulting to item number
update public.stock_lists set sort_by = coalesce(sort_by, 'style_no');



