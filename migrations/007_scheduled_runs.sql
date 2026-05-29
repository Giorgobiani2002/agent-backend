-- Scheduled runs: cron-based recurring playbook execution.
-- The backend's scheduler ticks every 60s and spawns runs whose next_run_at is past.

CREATE TABLE IF NOT EXISTS scheduled_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  playbook_id uuid NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  -- Standard 5-field cron expression, e.g. "0 9 15 * *" = 09:00 on day-15 of every month.
  cron_expression text NOT NULL,
  -- Fixed data passed to every run (e.g. credentials, period filters).
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  safety_mode text NOT NULL DEFAULT 'auto'
    CHECK (safety_mode IN ('auto', 'halt-on-dangerous', 'dry-run')),
  enabled boolean NOT NULL DEFAULT true,
  -- Timezone for cron evaluation. NULL → server-local. Honored by the scheduler tick.
  timezone text,
  -- When the scheduler should next consider this row. Set on create + after each run.
  next_run_at timestamptz,
  -- Convenience: latest spawn id and outcome, so the UI can show "last run".
  last_run_at timestamptz,
  last_run_status text,
  last_bulk_run_id uuid REFERENCES bulk_runs(id) ON DELETE SET NULL,
  -- Counts for the schedules dashboard.
  total_runs integer NOT NULL DEFAULT 0,
  total_failures integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_runs_due
  ON scheduled_runs (next_run_at)
  WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_playbook
  ON scheduled_runs (playbook_id);
