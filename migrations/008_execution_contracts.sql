-- Shared execution outcome contract and review metadata.

ALTER TABLE bulk_run_rows
  ADD COLUMN IF NOT EXISTS completion_state text
    CHECK (completion_state IN ('ready_for_review', 'submitted', 'failed'));

ALTER TABLE playbook_action_cache
  ADD COLUMN IF NOT EXISTS safety_mode text NOT NULL DEFAULT 'halt-on-dangerous'
    CHECK (safety_mode IN ('auto', 'halt-on-dangerous', 'dry-run')),
  ADD COLUMN IF NOT EXISTS completion_state text NOT NULL DEFAULT 'submitted'
    CHECK (completion_state IN ('ready_for_review', 'submitted', 'failed')),
  ADD COLUMN IF NOT EXISTS postconditions jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'reviewed'
    CHECK (review_status IN ('pending_review', 'reviewed')),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS extraction_warnings jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_playbooks_review_status
  ON playbooks (review_status);
