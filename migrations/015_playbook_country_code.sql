-- Tag every playbook with the country whose tax-authority portal it drives,
-- so the global playbook library (Phase 5 of purrfect-skipping-hummingbird.md)
-- can be partitioned by jurisdiction. Existing rows backfill to 'GE' because
-- the only adapter shipped today is rs.ge.

ALTER TABLE playbooks
  ADD COLUMN IF NOT EXISTS country_code text NOT NULL DEFAULT 'GE';

CREATE INDEX IF NOT EXISTS idx_playbooks_country_code
  ON playbooks (country_code);

-- Index by (country_code, company_id) too, since the most common query in
-- the multi-tenant world is "all my playbooks for this country".
CREATE INDEX IF NOT EXISTS idx_playbooks_country_company
  ON playbooks (country_code, company_id);
