-- Phase 1: multi-tenancy. Every row carries the owning Declario company.
-- Child tables (book_chunks, messages, bulk_run_rows, playbook_action_cache)
-- inherit isolation via their FK to a per-company parent, so they don't need
-- their own company_id column.

ALTER TABLE books                   ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';
ALTER TABLE conversations           ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';
ALTER TABLE playbooks               ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';
ALTER TABLE bulk_runs               ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';
ALTER TABLE scheduled_runs          ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';
ALTER TABLE site_memory             ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';
ALTER TABLE agent_failure_patterns  ADD COLUMN IF NOT EXISTS company_id text NOT NULL DEFAULT '__legacy__';

-- site_memory was keyed on (domain) globally; now the same domain can have
-- per-company knowledge. Drop the bare PK and recreate as (company_id, domain).
ALTER TABLE site_memory DROP CONSTRAINT IF EXISTS site_memory_pkey;
ALTER TABLE site_memory ADD CONSTRAINT site_memory_company_domain_pkey PRIMARY KEY (company_id, domain);

-- Same dedup logic but scoped per company so two tenants can record the same pattern.
DROP INDEX IF EXISTS uq_failure_patterns_dedup;
CREATE UNIQUE INDEX IF NOT EXISTS uq_failure_patterns_dedup
  ON agent_failure_patterns (
    company_id,
    domain,
    COALESCE(url_pattern, ''),
    COALESCE(field_label, ''),
    failure_type
  );

CREATE INDEX IF NOT EXISTS idx_books_company             ON books (company_id);
CREATE INDEX IF NOT EXISTS idx_conversations_company     ON conversations (company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_playbooks_company         ON playbooks (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_runs_company         ON bulk_runs (company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_company    ON scheduled_runs (company_id);
CREATE INDEX IF NOT EXISTS idx_failure_patterns_company  ON agent_failure_patterns (company_id, domain);
