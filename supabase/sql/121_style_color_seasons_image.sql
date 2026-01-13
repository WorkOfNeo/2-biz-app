-- 121_style_color_seasons_image.sql
-- Add image_url to style_color_seasons for per-color-per-season images

ALTER TABLE public.style_color_seasons
ADD COLUMN IF NOT EXISTS image_url TEXT;

COMMENT ON COLUMN public.style_color_seasons.image_url IS 'Color image URL from SPY Materials tab, full size (s1024)';
