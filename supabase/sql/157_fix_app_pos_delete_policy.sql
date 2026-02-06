-- Verify and fix app_pos DELETE policy
-- Ensures authenticated users can delete APP POs

-- Drop existing delete policy if it exists
DROP POLICY IF EXISTS "allow authenticated delete app_pos" ON public.app_pos;

-- Recreate the DELETE policy
CREATE POLICY "allow authenticated delete app_pos"
  ON public.app_pos FOR DELETE
  TO authenticated
  USING (true);

-- Also ensure app_po_lines can be deleted (cascade)
DROP POLICY IF EXISTS "allow authenticated delete app_po_lines" ON public.app_po_lines;

CREATE POLICY "allow authenticated delete app_po_lines"
  ON public.app_po_lines FOR DELETE
  TO authenticated
  USING (true);

-- Verify RLS is enabled
ALTER TABLE public.app_pos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_po_lines ENABLE ROW LEVEL SECURITY;

-- Comments
COMMENT ON POLICY "allow authenticated delete app_pos" ON public.app_pos 
  IS 'Allows all authenticated users to delete APP POs';

COMMENT ON POLICY "allow authenticated delete app_po_lines" ON public.app_po_lines 
  IS 'Allows all authenticated users to delete APP PO lines';
