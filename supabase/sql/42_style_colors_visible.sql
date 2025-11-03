-- 42_style_colors_visible.sql
-- Add a per-color visibility toggle for stock list

alter table public.style_colors
  add column if not exists visible boolean;

-- Default to true (visible) when null for ease of rollout
update public.style_colors set visible = true where visible is null;


