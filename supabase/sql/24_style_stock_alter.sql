-- 24_style_stock_alter.sql
-- Make row_label not null with default '', add updated_at, and add upsert key

alter table public.style_stock alter column row_label set default '';
update public.style_stock set row_label = '' where row_label is null;
alter table public.style_stock alter column row_label set not null;

alter table public.style_stock add column if not exists updated_at timestamptz not null default now();

drop index if exists uq_style_stock_key;
create unique index uq_style_stock_key on public.style_stock(style_no, color, section, row_label);


