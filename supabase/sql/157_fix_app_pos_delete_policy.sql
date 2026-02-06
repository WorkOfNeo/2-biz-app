-- Verify and fix app_pos DELETE policy
-- Ensures authenticated users can delete APP POs

-- Drop existing delete policy if it exists
DROP POLICY IF EXISTS "allow authenticated delete app_pos" ON public.app_pos;

-- Recreate the DELETE policy
CREATE POLICY "allow authenticated delete app_pos"
  ON public.app_pos FOR DELETE
  TO authenticated
  USING (true);

-- Also ensure app_po_lines can be deleted (if table exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'app_po_lines') THEN
    DROP POLICY IF EXISTS "allow authenticated delete app_po_lines" ON public.app_po_lines;
    
    CREATE POLICY "allow authenticated delete app_po_lines"
      ON public.app_po_lines FOR DELETE
      TO authenticated
      USING (true);
    
    ALTER TABLE public.app_po_lines ENABLE ROW LEVEL SECURITY;
    
    COMMENT ON POLICY "allow authenticated delete app_po_lines" ON public.app_po_lines 
      IS 'Allows all authenticated users to delete APP PO lines';
  END IF;
END $$;

-- Verify RLS is enabled on app_pos
ALTER TABLE public.app_pos ENABLE ROW LEVEL SECURITY;

-- Comment
COMMENT ON POLICY "allow authenticated delete app_pos" ON public.app_pos 
  IS 'Allows all authenticated users to delete APP POs';
