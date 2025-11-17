-- 57_styles_type.sql
-- Add optional style_type (e.g., PANTS, BLOUSE) to styles

alter table if exists public.styles
  add column if not exists style_type text;


