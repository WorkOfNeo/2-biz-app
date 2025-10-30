-- 31_statistics_per_size_unique.sql
-- Enforce at most one snapshot per day

create unique index if not exists uid_sps_snapshots_date on public.statistics_per_size_snapshots(date_from);


