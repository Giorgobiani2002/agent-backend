-- Cached successful action sequences per playbook.
-- When a playbook run succeeds via AI mode, we record the exact sequence of
-- browser actions (xpath, ax_name, attributes, value) so future runs of the
-- same playbook can replay deterministically without invoking the LLM.

CREATE TABLE IF NOT EXISTS playbook_action_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_id uuid NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  -- Hash of the playbook's recorded steps. Cache invalidates when steps change.
  playbook_version text NOT NULL,
  -- Array of cached actions: [{ index, action, x_path, ax_name, attributes, value_template, url, ... }]
  actions jsonb NOT NULL,
  -- Number of times this cache has been replayed successfully end-to-end.
  success_count integer NOT NULL DEFAULT 0,
  -- Number of times this cache has been recorded (overwrites prior versions).
  recorded_count integer NOT NULL DEFAULT 1,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (playbook_id, playbook_version)
);

CREATE INDEX IF NOT EXISTS idx_playbook_action_cache_playbook_id
  ON playbook_action_cache (playbook_id);
