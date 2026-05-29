-- Phase 4 (Trust & audit) — persist every Financial Agent Stack run.
--
-- The stack runs in services/financial-agent-stack.ts and produces four
-- artefacts per operation: classifier output, tax-reasoning output, action
-- plan, and the deterministic approval decision. This table is the audit
-- trail and the source of the approval queue UI. It also feeds the
-- previous-period-median anomaly check back into the next operation's
-- ApprovalContext.
--
-- One row per analyse-financial-operation call. Outputs are stored as JSONB
-- so the agent versions can evolve without a migration.

CREATE TABLE IF NOT EXISTS agent_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                  text NOT NULL,

  -- The original operation that was analysed (invoice, transaction, etc.).
  operation                   jsonb NOT NULL,
  -- The category the Classifier picked. Promoted to a column so the median
  -- query for anomaly detection stays cheap.
  category                    text NOT NULL,
  -- Operation amount + currency for the unusual-amount rule. NULL when the
  -- caller didn't supply approvalContext.amount.
  amount                      numeric(20, 4),
  currency                    text,

  -- Each agent's full StructuredAgentResult (output + confidence + warnings
  -- + model + attempts + latencyMs + rawText).
  classification              jsonb NOT NULL,
  tax_reasoning               jsonb NOT NULL,
  action_plan                 jsonb NOT NULL,

  -- Approval Gate's deterministic decision. Promoted columns let the
  -- approval queue UI filter cheaply.
  approval                    jsonb NOT NULL,
  approved                    boolean NOT NULL,
  tax_risk                    text NOT NULL,
  -- Lifecycle state. `pending_review` rows show in the approval queue;
  -- `executed` rows are done; `rejected` rows the human declined.
  status                      text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'executed', 'rejected', 'auto_approved')),

  -- Combined min(classification, taxReasoning, actionPlan).confidence —
  -- promoted so the queue sort-by-confidence is cheap.
  combined_confidence         double precision NOT NULL,

  -- Optional human review trail.
  reviewed_by                 text,
  reviewed_at                 timestamptz,
  review_note                 text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- The approval queue: list company's not-yet-decided runs newest first.
CREATE INDEX IF NOT EXISTS idx_agent_runs_company_status
  ON agent_runs (company_id, status, created_at DESC);

-- The anomaly check: median amount per (company, category, currency)
-- over recent history. Partial index keeps it tight — auto_approved +
-- executed rows are the historical baseline.
CREATE INDEX IF NOT EXISTS idx_agent_runs_history_for_median
  ON agent_runs (company_id, category, currency, created_at DESC)
  WHERE amount IS NOT NULL AND status IN ('auto_approved', 'approved', 'executed');

-- Lookup by tax risk (e.g. the "show me all high-risk operations" view).
CREATE INDEX IF NOT EXISTS idx_agent_runs_company_tax_risk
  ON agent_runs (company_id, tax_risk, created_at DESC);

-- Keep updated_at honest without an app-level write.
CREATE OR REPLACE FUNCTION agent_runs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_agent_runs_updated_at ON agent_runs;
CREATE TRIGGER trg_agent_runs_updated_at
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_set_updated_at();
