-- Let reviewers explicitly reject badly extracted playbooks.

ALTER TABLE playbooks
  DROP CONSTRAINT IF EXISTS playbooks_review_status_check;

ALTER TABLE playbooks
  ADD CONSTRAINT playbooks_review_status_check
  CHECK (review_status IN ('pending_review', 'reviewed', 'rejected'));

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
