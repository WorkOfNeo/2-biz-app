-- 145_finance_correction_runs_export_no_sumup.sql
-- Link CORRECTION runs to Export No. sum ups for quick lookup in UI

alter table if exists public.finance_correction_runs
  add column if not exists export_no_sumup_id uuid;

alter table if exists public.finance_correction_runs
  add column if not exists export_no_count int not null default 0;

do $$ begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'finance_correction_runs_export_no_sumup_id_fkey'
  ) then
    alter table public.finance_correction_runs
      add constraint finance_correction_runs_export_no_sumup_id_fkey
      foreign key (export_no_sumup_id)
      references public.finance_correction_export_no_sumups(id)
      on delete set null;
  end if;
end $$;

create index if not exists idx_finance_correction_runs_export_no_sumup_id
  on public.finance_correction_runs(export_no_sumup_id);

comment on column public.finance_correction_runs.export_no_sumup_id is 'Reference to saved Export No. unique list for this run';
comment on column public.finance_correction_runs.export_no_count is 'Count of unique Export No. values for this run';

