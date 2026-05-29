CREATE TABLE IF NOT EXISTS playbooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('upload', 'youtube')),
  source_path text NOT NULL,
  source_url text,
  duration_seconds double precision,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'analyzing', 'ready', 'failed')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  step_count integer NOT NULL DEFAULT 0,
  model text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_playbooks_status ON playbooks (status);
CREATE INDEX IF NOT EXISTS idx_playbooks_source_path ON playbooks (source_path);
CREATE INDEX IF NOT EXISTS idx_playbooks_created_at ON playbooks (created_at DESC);
