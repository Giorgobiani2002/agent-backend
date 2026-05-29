-- Knowledge base (books) is shared across all Declario companies. The chat
-- brain knows accounting + finance the same way for everyone; only platform
-- admins seed it. Playbooks, conversations, runs, etc. stay per-company.
--
-- Migration 013 added company_id to books; this one removes it. The default
-- '__legacy__' value migration 013 backfilled is dropped along with the
-- column, which is fine because no production rows used it (the agent-backend
-- was running multi-tenant for less than a release).

ALTER TABLE books DROP COLUMN IF EXISTS company_id;

DROP INDEX IF EXISTS idx_books_company;
