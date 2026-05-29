-- Add a stable, human-readable lookup key to playbooks so the AI Action
-- Planner can reference them by name (e.g. "rs.ge.invoice") and the
-- executor can resolve to a concrete playbook row.
--
-- Playbook keys are unique per (company_id, country_code). Two companies
-- can each have their own "rs.ge.invoice" playbook with different
-- recorded steps; the executor always scopes by tenant first.
--
-- Nullable on purpose: existing playbooks were recorded before keys
-- existed. The owner can backfill via the UI as they go.

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS key text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_playbooks_company_country_key
  ON playbooks (company_id, country_code, key)
  WHERE key IS NOT NULL;
