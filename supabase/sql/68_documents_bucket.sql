-- Create storage bucket for APP PO documents (PDFs and Excel files)
-- 
-- IMPORTANT: The storage bucket must be created manually in Supabase Dashboard:
-- 1. Go to Storage section in Supabase Dashboard
-- 2. Click "New bucket"
-- 3. Name: documents
-- 4. Public: OFF (unchecked)
-- 5. File size limit: 52428800 (50MB)
-- 6. Allowed MIME types: application/pdf, application/vnd.ms-excel, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
--
-- The bucket creation cannot be done via SQL migration due to permission restrictions.

-- Allow authenticated users to upload files
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'allow authenticated upload documents'
  ) THEN
    CREATE POLICY "allow authenticated upload documents"
      ON storage.objects FOR INSERT
      TO authenticated
      WITH CHECK (bucket_id = 'documents');
  END IF;
END $$;

-- Allow authenticated users to read files
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'allow authenticated read documents'
  ) THEN
    CREATE POLICY "allow authenticated read documents"
      ON storage.objects FOR SELECT
      TO authenticated
      USING (bucket_id = 'documents');
  END IF;
END $$;

-- Allow authenticated users to update files
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'allow authenticated update documents'
  ) THEN
    CREATE POLICY "allow authenticated update documents"
      ON storage.objects FOR UPDATE
      TO authenticated
      USING (bucket_id = 'documents')
      WITH CHECK (bucket_id = 'documents');
  END IF;
END $$;

-- Allow authenticated users to delete files
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'storage' 
    AND tablename = 'objects' 
    AND policyname = 'allow authenticated delete documents'
  ) THEN
    CREATE POLICY "allow authenticated delete documents"
      ON storage.objects FOR DELETE
      TO authenticated
      USING (bucket_id = 'documents');
  END IF;
END $$;

-- Add comment
COMMENT ON COLUMN storage.buckets.id IS 'Storage bucket for APP PO documents';

