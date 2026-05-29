CREATE TABLE IF NOT EXISTS bulk_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'stalled', 'cancelled')),
  total_rows integer NOT NULL DEFAULT 0,
  ok_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  worker_pid integer,
  last_heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_runs_status_heartbeat
  ON bulk_runs (status, last_heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_bulk_runs_created_at
  ON bulk_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS bulk_run_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES bulk_runs(id) ON DELETE CASCADE,
  row_index integer NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'success', 'failed', 'skipped')),
  playbook_id uuid REFERENCES playbooks(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  screenshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  action_log jsonb NOT NULL DEFAULT '[]'::jsonb,
  steps_taken integer,
  recording_path text,
  worker_id uuid,
  lock_version integer NOT NULL DEFAULT 0,
  UNIQUE (run_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_bulk_run_rows_pending
  ON bulk_run_rows (run_id, status)
  WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_bulk_run_rows_run_id_row_index
  ON bulk_run_rows (run_id, row_index);
