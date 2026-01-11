-- Add contacts JSONB field to suppliers table
-- Contacts structure: [{ name: string, email: string, role?: string, primary?: boolean }]

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contacts jsonb DEFAULT '[]'::jsonb;

-- Create index for querying contacts
CREATE INDEX IF NOT EXISTS idx_suppliers_contacts ON suppliers USING gin (contacts);

COMMENT ON COLUMN suppliers.contacts IS 'Array of contact persons: [{ name, email, role?, primary? }]';


