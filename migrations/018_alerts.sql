-- Phase 6 Slice B — passive alerts surface.
--
-- The alert generator (services/alert-generator.ts) sweeps failure
-- feeds (bulk_run_rows, rs-server pipelineRuns, rs-server declarations)
-- every minute on the scheduler tick and UPSERTs into this table keyed
-- on `dedup_key`. The UI shows open alerts as a topbar badge + a list
-- page; the chat reads them through tools.
--
-- Lifecycle: open → acknowledged → resolved (auto when failures quiet
-- down for N hours) or → snoozed. The unique-by-dedup_key partial index
-- ensures repeated failures bump `count` on the existing row instead of
-- creating duplicates while the alert is still actionable.

CREATE TABLE IF NOT EXISTS alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        text NOT NULL,

  -- Logical kind, e.g. "bulk_rows_failing", "pipeline_run_failed",
  -- "declaration_rejected". Drives the UI icon + the chat tool
  -- suggested_actions vocabulary.
  kind              text NOT NULL,
  severity          text NOT NULL
    CHECK (severity IN ('info', 'warn', 'critical')),

  -- Optional pointer to the entity this alert is about, so the
  -- contextual banner on /waybills/:id can fetch alerts for the exact
  -- thing the user is looking at.
  entity_type       text,
  entity_id         text,

  -- Number of underlying failures rolled up into this alert. Bumps on
  -- every sweep that finds matching new failures.
  count             int NOT NULL DEFAULT 1,

  -- One-line summary shown in lists + badge tooltips.
  title             text NOT NULL,
  -- LLM-generated explanation; refreshed only when count doubles or
  -- every 6h to bound Gemini cost.
  root_cause        text,
  -- Array of { tool, args, label }; the UI renders one button per
  -- element. tool name must match a registered chat tool.
  suggested_actions jsonb NOT NULL DEFAULT '[]'::jsonb,

  status            text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'acknowledged', 'resolved', 'snoozed')),

  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_by   text,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  snoozed_until     timestamptz,

  -- Stable hash used to dedupe across sweeps. The generator computes
  -- it from (company_id, kind, entity_type, entity_id, date_bucket).
  dedup_key         text NOT NULL,
  -- Free-form extras: list of failing entity IDs, error class string,
  -- last raw error message, etc. The contextual banner reads this for
  -- per-entity matching.
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One open or acknowledged alert per dedup_key. Resolved/snoozed rows
-- don't participate so a recurring failure surfaces fresh.
CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_dedup
  ON alerts (company_id, dedup_key)
  WHERE status IN ('open', 'acknowledged');

-- Cheap "load my queue" query for the topbar + /alerts page.
CREATE INDEX IF NOT EXISTS idx_alerts_company_open
  ON alerts (company_id, status, severity, last_seen_at DESC);

-- "Are there alerts for THIS waybill?" — used by the contextual banner.
CREATE INDEX IF NOT EXISTS idx_alerts_entity
  ON alerts (company_id, entity_type, entity_id)
  WHERE status IN ('open', 'acknowledged');

CREATE OR REPLACE FUNCTION alerts_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alerts_updated_at ON alerts;
CREATE TRIGGER trg_alerts_updated_at
  BEFORE UPDATE ON alerts
  FOR EACH ROW
  EXECUTE FUNCTION alerts_set_updated_at();
