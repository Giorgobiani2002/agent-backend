-- Deterministic pre-submit review payload captured from the browser DOM.

ALTER TABLE bulk_run_rows
  ADD COLUMN IF NOT EXISTS review_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
