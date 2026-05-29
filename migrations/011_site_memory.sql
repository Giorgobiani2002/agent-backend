-- Phase Q1: Aggregated browser-automation knowledge per domain.
-- Distilled from EVERY reviewed playbook on a domain. The free-form Worker
-- consumes this when no single playbook scores high enough to drive the run
-- on its own (scoreTaskAgainstPlaybook < 0.35 in routes/agent.ts), so it still
-- has site-specific grounding (menu hierarchy, common transitions, dialog
-- patterns) instead of falling back to pure ungrounded LLM clicking.

CREATE TABLE IF NOT EXISTS site_memory (
  domain                 text PRIMARY KEY,
  knowledge_json         jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_playbook_count  int   NOT NULL DEFAULT 0,
  source_playbook_ids    uuid[] NOT NULL DEFAULT '{}'::uuid[],
  updated_at             timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_memory_updated_at
  ON site_memory (updated_at DESC);
