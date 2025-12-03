-- 81_customer_comments.sql
-- Store comments for customers per season, with option for permanent comments

create table if not exists public.customer_comments (
  id uuid primary key default gen_random_uuid(),
  customer_id text not null references public.customers(customer_id) on delete cascade,
  season_id uuid references public.seasons(id) on delete cascade,
  comment text not null,
  is_permanent boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Ensure one comment per customer per season (or one permanent per customer)
  unique(customer_id, season_id, is_permanent)
);

-- Indexes for efficient lookups
create index if not exists idx_customer_comments_customer_id on public.customer_comments(customer_id);
create index if not exists idx_customer_comments_season_id on public.customer_comments(season_id);
create index if not exists idx_customer_comments_permanent on public.customer_comments(customer_id, is_permanent) where is_permanent = true;

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_customer_comments_updated_at on public.customer_comments;
create trigger trg_customer_comments_updated_at before update on public.customer_comments
for each row execute procedure public.set_updated_at();

-- RLS policies
alter table public.customer_comments enable row level security;

drop policy if exists customer_comments_select_all on public.customer_comments;
create policy customer_comments_select_all on public.customer_comments
  for select using (true);

drop policy if exists customer_comments_insert_authenticated on public.customer_comments;
create policy customer_comments_insert_authenticated on public.customer_comments
  for insert with check (true);

drop policy if exists customer_comments_update_authenticated on public.customer_comments;
create policy customer_comments_update_authenticated on public.customer_comments
  for update using (true);

drop policy if exists customer_comments_delete_authenticated on public.customer_comments;
create policy customer_comments_delete_authenticated on public.customer_comments
  for delete using (true);

