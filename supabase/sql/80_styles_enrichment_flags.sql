-- 80_styles_enrichment_flags.sql
-- Add columns to track styles that need enrichment and styles missing from SPY

alter table if exists public.styles
  add column if not exists needs_enrichment boolean not null default false;

alter table if exists public.styles
  add column if not exists missing_from_spy boolean not null default false;

comment on column public.styles.needs_enrichment is 'Set to true to force re-enrichment of style_type on next enrich_styles job run';
comment on column public.styles.missing_from_spy is 'Automatically set to true when style exists in DB but not found in SPY during scrape';

create index if not exists idx_styles_needs_enrichment on public.styles(needs_enrichment) where needs_enrichment = true;
create index if not exists idx_styles_missing_from_spy on public.styles(missing_from_spy) where missing_from_spy = true;

