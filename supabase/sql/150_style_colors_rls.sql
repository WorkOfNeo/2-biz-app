-- 150_style_colors_rls.sql
-- Allow authenticated users to read and insert style_colors (e.g. add new colors from Historical Sales)

alter table if exists public.style_colors enable row level security;

-- Drop existing policies if they exist (by name) to avoid duplicates
drop policy if exists "style_colors_select_authenticated" on public.style_colors;
drop policy if exists "style_colors_insert_authenticated" on public.style_colors;
drop policy if exists "style_colors_update_authenticated" on public.style_colors;

-- Select: authenticated users can read all style_colors
create policy "style_colors_select_authenticated"
  on public.style_colors for select
  to authenticated
  using (true);

-- Insert: authenticated users can add new colors (e.g. from Historical Sales upload)
create policy "style_colors_insert_authenticated"
  on public.style_colors for insert
  to authenticated
  with check (true);

-- Update: authenticated users can update (e.g. visible, inactive, is_noos)
create policy "style_colors_update_authenticated"
  on public.style_colors for update
  to authenticated
  using (true)
  with check (true);
