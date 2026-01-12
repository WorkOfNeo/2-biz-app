-- Add pdf_url column to ai_season_analyses table
-- This stores the URL to the generated PDF report for each analysis

ALTER TABLE ai_season_analyses 
ADD COLUMN IF NOT EXISTS pdf_url TEXT;

COMMENT ON COLUMN ai_season_analyses.pdf_url IS 'URL to the generated PDF report for this analysis';
