-- 89_exports_add_comment.sql
-- Add comment column to exports table

alter table public.exports
  add column if not exists comment text;
