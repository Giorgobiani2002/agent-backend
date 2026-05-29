ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'task'
    CHECK (kind IN ('task', 'login'));

-- Exactly one playbook can be marked as the login playbook at any time.
CREATE UNIQUE INDEX IF NOT EXISTS one_login_playbook
  ON playbooks (kind)
  WHERE kind = 'login';
