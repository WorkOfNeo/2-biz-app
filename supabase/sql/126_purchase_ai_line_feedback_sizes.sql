-- 126_purchase_ai_line_feedback_sizes.sql
-- Extend purchase_ai_line_feedback with per-size breakdown storage

-- Add per-size breakdown columns
ALTER TABLE public.purchase_ai_line_feedback
  ADD COLUMN IF NOT EXISTS sizes text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS suggested_breakdown integer[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS adjusted_breakdown integer[] DEFAULT '{}';

-- Add open PO tracking (how much was already on order when suggestion was made)
ALTER TABLE public.purchase_ai_line_feedback
  ADD COLUMN IF NOT EXISTS open_po_qty integer DEFAULT 0;

-- Add active salespeople count (for context)
ALTER TABLE public.purchase_ai_line_feedback
  ADD COLUMN IF NOT EXISTS active_salespeople_count integer DEFAULT 0;

-- Comments
COMMENT ON COLUMN public.purchase_ai_line_feedback.sizes IS 
  'Size labels in order, e.g. ["XS","S","M","L","XL"]';
COMMENT ON COLUMN public.purchase_ai_line_feedback.suggested_breakdown IS 
  'AI-suggested quantities per size, same order as sizes array';
COMMENT ON COLUMN public.purchase_ai_line_feedback.adjusted_breakdown IS 
  'User-adjusted quantities per size (null if not adjusted)';
COMMENT ON COLUMN public.purchase_ai_line_feedback.open_po_qty IS 
  'Quantity already on open POs when this suggestion was made';
COMMENT ON COLUMN public.purchase_ai_line_feedback.active_salespeople_count IS 
  'Number of unique salespeople who sold this style/color';
