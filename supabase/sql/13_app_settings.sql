-- 13_app_settings.sql
-- Key/value app settings storage

create table if not exists public.app_settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at trigger
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_app_settings_updated_at on public.app_settings;
create trigger trg_app_settings_updated_at before update on public.app_settings
for each row execute procedure public.set_updated_at();

-- RLS + policies
alter table public.app_settings enable row level security;

drop policy if exists app_settings_select_all on public.app_settings;
create policy app_settings_select_all on public.app_settings for select to public using (true);

drop policy if exists app_settings_insert_authenticated on public.app_settings;
create policy app_settings_insert_authenticated on public.app_settings for insert to authenticated with check (true);

drop policy if exists app_settings_update_authenticated on public.app_settings;
create policy app_settings_update_authenticated on public.app_settings for update to authenticated using (true) with check (true);


