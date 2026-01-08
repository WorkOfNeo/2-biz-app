-- Conversations system for APP PO email tracking
-- Created: 2026-01-08

-- Conversations linked to APP POs
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_po_id integer REFERENCES app_pos(id) ON DELETE CASCADE,
  subject text NOT NULL,
  supplier_email text,
  status text DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'confirmed', 'closed')),
  thread_id text, -- Microsoft Graph conversation/thread ID
  last_message_at timestamptz,
  ai_summary text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Individual messages in a conversation
CREATE TABLE IF NOT EXISTS conversation_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  from_email text,
  to_email text,
  subject text,
  body_html text,
  body_text text,
  sent_at timestamptz,
  graph_message_id text, -- Microsoft Graph message ID
  ai_analysis jsonb, -- { confirmed: bool, questions: [], action_needed: bool, etd_mentioned: string, eta_mentioned: string }
  created_at timestamptz DEFAULT now()
);

-- Microsoft Graph OAuth tokens (encrypted storage)
CREATE TABLE IF NOT EXISTS graph_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  access_token_encrypted text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  expires_at timestamptz NOT NULL,
  email text, -- The connected email account
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversations_app_po_id ON conversations(app_po_id);
CREATE INDEX IF NOT EXISTS idx_conversations_status ON conversations(status);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_id ON conversation_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_sent_at ON conversation_messages(sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_graph_id ON conversation_messages(graph_message_id);
CREATE INDEX IF NOT EXISTS idx_graph_tokens_user_id ON graph_tokens(user_id);

-- RLS policies
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE graph_tokens ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to read/write conversations
CREATE POLICY "Authenticated users can read conversations" ON conversations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert conversations" ON conversations
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update conversations" ON conversations
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Authenticated users can delete conversations" ON conversations
  FOR DELETE TO authenticated USING (true);

-- Allow authenticated users to read/write messages
CREATE POLICY "Authenticated users can read messages" ON conversation_messages
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated users can insert messages" ON conversation_messages
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Authenticated users can update messages" ON conversation_messages
  FOR UPDATE TO authenticated USING (true);

-- Graph tokens - users can only access their own
CREATE POLICY "Users can read own graph tokens" ON graph_tokens
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own graph tokens" ON graph_tokens
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own graph tokens" ON graph_tokens
  FOR UPDATE TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own graph tokens" ON graph_tokens
  FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_conversation_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_updated_at();

CREATE TRIGGER graph_tokens_updated_at
  BEFORE UPDATE ON graph_tokens
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_updated_at();

