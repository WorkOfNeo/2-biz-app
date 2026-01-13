-- 122_style_colors_image.sql
-- Add image_url to style_colors for per-color images (cleaner than per-season)

ALTER TABLE public.style_colors
ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN public.style_colors.image_url IS 'Color image URL from SPY Materials tab, full size (s1024)';

-- Drop the column from style_color_seasons if it was added (cleanup from previous migration)
ALTER TABLE public.style_color_seasons
DROP COLUMN IF EXISTS image_url;
