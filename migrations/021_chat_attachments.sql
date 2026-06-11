CREATE TABLE IF NOT EXISTS chat_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text,
  original_name text NOT NULL,
  mime_type text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('payroll_spreadsheet')),
  size_bytes integer NOT NULL,
  status text NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed', 'rejected')),
  parsed_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_attachments_conversation
  ON chat_attachments(company_id, conversation_id, created_at);
