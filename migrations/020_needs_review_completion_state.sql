-- Add the "needs_review" completion state: a submission whose deterministic
-- checks passed but whose confirmation page could not be visually verified.
-- It is a SUCCESS outcome flagged for a quick human glance — never a failure.
-- Previously these were forced to "failed", producing false negatives even
-- though the data had actually reached rs.ge.

ALTER TABLE bulk_run_rows
  DROP CONSTRAINT IF EXISTS bulk_run_rows_completion_state_check;
ALTER TABLE bulk_run_rows
  ADD CONSTRAINT bulk_run_rows_completion_state_check
    CHECK (completion_state IN ('ready_for_review', 'submitted', 'failed', 'needs_review'));

ALTER TABLE playbook_action_cache
  DROP CONSTRAINT IF EXISTS playbook_action_cache_completion_state_check;
ALTER TABLE playbook_action_cache
  ADD CONSTRAINT playbook_action_cache_completion_state_check
    CHECK (completion_state IN ('ready_for_review', 'submitted', 'failed', 'needs_review'));
