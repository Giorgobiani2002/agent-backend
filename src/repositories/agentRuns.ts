import { query } from "../db";
import type { FinancialAgentStackResult } from "../services/financial-agent-stack";

/**
 * Repository for the `agent_runs` table — every Financial Agent Stack run
 * persisted for audit, approval-queue UI, and anomaly detection.
 *
 * Migration 016_agent_runs.sql defines the table; see the comment block
 * there for the lifecycle states.
 */

export type AgentRunStatus =
  | "pending_review"
  | "approved"
  | "executed"
  | "rejected"
  | "auto_approved";

export interface AgentRunRow {
  id: string;
  company_id: string;
  operation: unknown;
  category: string;
  amount: number | null;
  currency: string | null;
  classification: unknown;
  tax_reasoning: unknown;
  action_plan: unknown;
  approval: unknown;
  approved: boolean;
  tax_risk: string;
  status: AgentRunStatus;
  combined_confidence: number;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertAgentRunInput {
  companyId: string;
  operation: unknown;
  amount?: number | null;
  currency?: string | null;
  result: FinancialAgentStackResult;
}

/**
 * Persist a full Financial Agent Stack run. Initial status follows the
 * Approval Gate: auto_approved when nothing blocked, pending_review when
 * a block fired. The caller (route layer) is expected to wrap this in a
 * try/catch — persistence failures should NOT take down the analyse call,
 * but they should be logged.
 */
export async function insertAgentRun(input: InsertAgentRunInput): Promise<AgentRunRow> {
  const { companyId, operation, amount, currency, result } = input;
  const status: AgentRunStatus = result.approval.approved ? "auto_approved" : "pending_review";

  const inserted = await query<AgentRunRow>(
    `
      INSERT INTO agent_runs (
        company_id,
        operation,
        category,
        amount,
        currency,
        classification,
        tax_reasoning,
        action_plan,
        approval,
        approved,
        tax_risk,
        status,
        combined_confidence
      ) VALUES (
        $1, $2::jsonb, $3, $4, $5,
        $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb,
        $10, $11, $12, $13
      )
      RETURNING *
    `,
    [
      companyId,
      JSON.stringify(operation ?? null),
      result.classification.output.category,
      typeof amount === "number" && Number.isFinite(amount) ? amount : null,
      typeof currency === "string" && currency ? currency : null,
      JSON.stringify(result.classification),
      JSON.stringify(result.taxReasoning),
      JSON.stringify(result.actionPlan),
      JSON.stringify(result.approval),
      result.approval.approved,
      result.taxReasoning.output.tax_risk,
      status,
      result.summary.confidence,
    ],
  );

  return inserted.rows[0];
}

export interface ListAgentRunsFilter {
  companyId: string;
  status?: AgentRunStatus | AgentRunStatus[];
  category?: string;
  taxRisk?: string;
  limit?: number;
  offset?: number;
}

export async function listAgentRuns(filter: ListAgentRunsFilter): Promise<AgentRunRow[]> {
  const { companyId, status, category, taxRisk } = filter;
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const conds: string[] = ["company_id = $1"];
  const params: unknown[] = [companyId];

  if (status) {
    const arr = Array.isArray(status) ? status : [status];
    conds.push(`status = ANY($${params.length + 1}::text[])`);
    params.push(arr);
  }
  if (category) {
    conds.push(`category = $${params.length + 1}`);
    params.push(category);
  }
  if (taxRisk) {
    conds.push(`tax_risk = $${params.length + 1}`);
    params.push(taxRisk);
  }

  params.push(limit);
  params.push(offset);

  const rows = await query<AgentRunRow>(
    `
      SELECT *
      FROM agent_runs
      WHERE ${conds.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params,
  );
  return rows.rows;
}

export async function getAgentRunById(
  companyId: string,
  id: string,
): Promise<AgentRunRow | null> {
  const result = await query<AgentRunRow>(
    `SELECT * FROM agent_runs WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, id],
  );
  return result.rows[0] ?? null;
}

export interface DecideAgentRunInput {
  companyId: string;
  id: string;
  decision: "approved" | "rejected" | "executed";
  reviewedBy?: string;
  reviewNote?: string;
}

export async function decideAgentRun(input: DecideAgentRunInput): Promise<AgentRunRow | null> {
  const result = await query<AgentRunRow>(
    `
      UPDATE agent_runs
      SET status = $3,
          reviewed_by = $4,
          reviewed_at = now(),
          review_note = $5
      WHERE company_id = $1 AND id = $2
      RETURNING *
    `,
    [
      input.companyId,
      input.id,
      input.decision,
      input.reviewedBy ?? null,
      input.reviewNote ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Median operation amount for (company, category, currency) over the last
 * `lookbackDays` days, considering only historically valid baseline rows
 * (auto_approved, approved, executed). Returns null when there's no
 * baseline yet — the Approval Gate treats that as "no previous-period
 * data" and emits an info flag instead of blocking.
 *
 * `percentile_cont(0.5)` is the cheapest way to get a true median in
 * Postgres; the partial index on the table keeps the row set tight.
 */
export async function medianAmountByCategory(input: {
  companyId: string;
  category: string;
  currency: string;
  lookbackDays?: number;
}): Promise<number | null> {
  const lookbackDays = input.lookbackDays ?? 90;
  const result = await query<{ median: string | null }>(
    `
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) AS median
      FROM agent_runs
      WHERE company_id = $1
        AND category = $2
        AND currency = $3
        AND amount IS NOT NULL
        AND status IN ('auto_approved', 'approved', 'executed')
        AND created_at >= now() - ($4 || ' days')::interval
    `,
    [input.companyId, input.category, input.currency, String(lookbackDays)],
  );
  const value = result.rows[0]?.median;
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
