-- Per-row retry support for bulk runs.
-- A failed row with a transient error (network, timeout, connection reset)
-- is automatically retried up to MAX_ROW_RETRIES times. The retry path
-- bumps attempt_count and resets status to 'pending' so the worker pool
-- picks the row back up via claimNextPendingRow.

ALTER TABLE bulk_run_rows
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;

-- Allow our retry logic to recognise rows that were retried.
CREATE INDEX IF NOT EXISTS idx_bulk_run_rows_attempts
  ON bulk_run_rows (run_id, attempt_count)
  WHERE status IN ('pending', 'failed');
