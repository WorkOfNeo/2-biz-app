-- Add DELETE policy for app_pos table
-- The original table creation (66_app_pos_table.sql) only added SELECT, INSERT, UPDATE policies
-- This migration adds the missing DELETE policy

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'app_pos' AND policyname = 'allow authenticated delete app_pos'
  ) THEN
    CREATE POLICY "allow authenticated delete app_pos"
      ON public.app_pos FOR DELETE
      TO authenticated
      USING (true);
  END IF;
END $$;

-- Comment for documentation
COMMENT ON POLICY "allow authenticated delete app_pos" ON public.app_pos IS 'Allows authenticated users to delete APP POs';
