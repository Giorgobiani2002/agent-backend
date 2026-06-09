import type { FunctionDeclaration } from "@google/genai";
import { query } from "../db";
import {
  getAlertById,
  listAlerts,
  setAlertStatus,
  type AlertStatus,
} from "../repositories/alerts";
import { listFailurePatterns } from "../repositories/failurePatterns";
import {
  findBulkRun,
  listBulkRuns,
  requeueRowForRetry,
  resetIncompleteRows,
  skipBulkRow,
} from "../repositories/bulkRuns";
import { runWriteTool, type WriteToolOutcome } from "./chat-write-tools";
import { classifyErrorText } from "./alert-generator";
import {
  findPlaybookById,
  listPlaybooks,
} from "../repositories/playbooks";
import {
  getAgentRunById,
  listAgentRuns,
  type AgentRunStatus,
} from "../repositories/agentRuns";
import {
  findScheduledRunById,
  listScheduledRuns,
} from "../repositories/scheduledRuns";
import { rsServerClient, RsServerClientError } from "./rs-server-client";

/**
 * Chat-tool registry (Slice A — read-only).
 *
 * Each tool is exposed to Gemini as a `FunctionDeclaration` and dispatched
 * here against either the agent-backend Postgres (bulk runs, playbooks,
 * agent runs, schedules, failure patterns) or rs-server's internal API
 * (waybills, declarations, pipeline runs, orders, integrations).
 *
 * Conventions:
 *   - Every tool is tenant-scoped via the `companyId` arg the dispatcher
 *     receives from chat. Tools never accept a company_id parameter from
 *     the model — that would be a cross-tenant leak.
 *   - Tools return plain JSON-serializable objects; never throw raw
 *     errors. Errors are converted to `{ error: string }` so the model
 *     can keep going (e.g. apologise to the user) instead of aborting
 *     the loop with an exception.
 *   - Parameter schemas use the same JSON-schema-ish shape Gemini
 *     accepts: `type`, `properties`, `required`. Keep them minimal —
 *     descriptions matter more than constraints for model accuracy.
 */

export interface ToolCallContext {
  companyId: string;
  userId?: string;
}

export type ToolHandler = (
  ctx: ToolCallContext,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

async function safeRsGet<T>(
  path: string,
  ctx: ToolCallContext,
  query?: Record<string, string | number | undefined>,
): Promise<T | { error: string }> {
  try {
    return await rsServerClient.get<T>(path, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      query,
    });
  } catch (err) {
    if (err instanceof RsServerClientError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Tool catalog ────────────────────────────────────────────────────────

export const CHAT_TOOLS: ChatTool[] = [
  // rs-server reads ──
  {
    name: "get_waybill",
    description:
      "Look up a single waybill belonging to the current company. Accepts either the internal waybill id (UUID) or the numeric rs.ge waybill id.",
    parameters: {
      type: "object",
      properties: {
        waybillId: { type: "string", description: "internal UUID or rs.ge numeric id" },
      },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const id = str(args.waybillId);
      if (!id) return { error: "waybillId is required" };
      return safeRsGet(`/internal/tools/waybills/${encodeURIComponent(id)}`, ctx);
    },
  },
  {
    name: "search_waybills",
    description:
      "List the company's most recent waybills, newest first. Supports filtering by rs.ge status code or by orderId.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "rs.ge numeric status (e.g. '0','1','-1')" },
        orderId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/waybills`, ctx, {
        status: str(args.status),
        orderId: str(args.orderId),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "get_declaration",
    description:
      "Look up a single declaration by its internal id. Returns the full record including the tax-authority response (rsge_response).",
    parameters: {
      type: "object",
      properties: { declarationId: { type: "string" } },
      required: ["declarationId"],
    },
    async handler(ctx, args) {
      const id = str(args.declarationId);
      if (!id) return { error: "declarationId is required" };
      return safeRsGet(
        `/internal/tools/declarations/${encodeURIComponent(id)}`,
        ctx,
      );
    },
  },
  {
    name: "list_declarations",
    description:
      "List the company's recent declarations, newest first. Use status='rejected' or status='submitted' to filter by lifecycle state.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "submitted", "approved", "rejected"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/declarations`, ctx, {
        status: str(args.status),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "draft_vat_return",
    description:
      "Draft and explain the company's monthly VAT (დღგ) return for a period. Computes output VAT (from sales invoices), input VAT (from ACCEPTED purchase invoices) and net VAT payable from the invoices synced to declario, returning totals, invoice counts, sample invoice ids and warnings. Use when the user asks to prepare/draft/explain their VAT for a month. The Georgian VAT rate is 18%. IMPORTANT: rs.ge has NO declaration API — this only DRAFTS the figures; the actual return is filed in the rs.ge UI. Ground the explanation in the Tax Code articles from the knowledge base and surface any warnings (e.g. input VAT not synced).",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year, e.g. 2026; defaults to the current period" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to the current period" },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/vat-preview`, ctx, {
        year: num(args.year),
        month: num(args.month),
      });
    },
  },
  {
    name: "list_pipeline_runs",
    description:
      "List the company's recent pipeline runs (the workflows that turn orders into waybills/declarations). Filter by status='failed' to see what broke.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["running", "completed", "failed"] },
        pipelineId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/pipeline-runs`, ctx, {
        status: str(args.status),
        pipelineId: str(args.pipelineId),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "get_pipeline_run",
    description: "Look up a single pipeline run with its step-by-step results and per-step errors.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    async handler(ctx, args) {
      const id = str(args.runId);
      if (!id) return { error: "runId is required" };
      return safeRsGet(
        `/internal/tools/pipeline-runs/${encodeURIComponent(id)}`,
        ctx,
      );
    },
  },
  {
    name: "list_orders",
    description: "List the company's recent orders ingested from connected platforms.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        source: { type: "string", description: "e.g. 'shopify', 'woocommerce'" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/orders`, ctx, {
        status: str(args.status),
        source: str(args.source),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "list_integrations",
    description: "List the company's connected platform integrations (Shopify, WooCommerce, etc.). Credentials are stripped.",
    parameters: { type: "object", properties: {} },
    async handler(ctx) {
      return safeRsGet(`/internal/tools/integrations`, ctx);
    },
  },

  // agent-backend reads ──
  {
    name: "get_bulk_run",
    description:
      "Look up a single agent bulk run with all its rows — most useful for explaining why N rows failed in a batch.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    async handler(ctx, args) {
      const id = str(args.runId);
      if (!id) return { error: "runId is required" };
      const run = await findBulkRun(ctx.companyId, id);
      return { run };
    },
  },
  {
    name: "list_failed_bulk_rows",
    description:
      "List failed rows across recent bulk runs for this company, newest first. Each row carries its error text plus the playbook it was running.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "limit to a specific run (optional)" },
        sinceHours: { type: "integer", minimum: 1, maximum: 720 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    async handler(ctx, args) {
      const sinceHours = num(args.sinceHours) ?? 168; // 7 days default
      const limit = Math.min(num(args.limit) ?? 100, 500);
      const runId = str(args.runId);
      const params: unknown[] = [ctx.companyId, sinceHours, limit];
      const result = await query<{
        run_id: string;
        row_index: number;
        playbook_id: string | null;
        status: string;
        error: string | null;
        attempt_count: number;
        finished_at: string | null;
      }>(
        `
          SELECT r.run_id, r.row_index, r.playbook_id, r.status, r.error,
                 r.attempt_count, r.finished_at
            FROM bulk_run_rows r
            JOIN bulk_runs br ON br.id = r.run_id
           WHERE br.company_id = $1
             AND r.status = 'failed'
             AND r.finished_at >= now() - ($2 || ' hours')::interval
             ${runId ? "AND r.run_id = $4" : ""}
           ORDER BY r.finished_at DESC
           LIMIT $3
        `,
        runId ? [...params, runId] : params,
      );
      return { rows: result.rows };
    },
  },
  {
    name: "get_failure_patterns",
    description:
      "List learned browser-agent failure patterns (e.g. 'this dropdown loses focus at step 3'), optionally narrowed to a domain.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "e.g. 'rs.ge'; omit for all" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    async handler(ctx, args) {
      const domain = str(args.domain);
      const limit = Math.min(num(args.limit) ?? 30, 100);
      if (domain) {
        return { patterns: await listFailurePatterns(ctx.companyId, domain, limit) };
      }
      const result = await query(
        `SELECT id, domain, url_pattern, field_label, failure_type, symptom,
                workaround, occurrence_count, first_seen_at, last_seen_at
           FROM agent_failure_patterns
          WHERE company_id = $1
          ORDER BY occurrence_count DESC, last_seen_at DESC
          LIMIT $2`,
        [ctx.companyId, limit],
      );
      return { patterns: result.rows };
    },
  },
  {
    name: "list_playbooks",
    description: "List the company's browser-agent playbooks with their review status and step count.",
    parameters: { type: "object", properties: {} },
    async handler(ctx) {
      const rows = await listPlaybooks(ctx.companyId);
      return {
        playbooks: rows.map((r) => ({
          id: r.id,
          name: r.name,
          key: r.key,
          kind: r.kind,
          status: r.status,
          review_status: r.review_status,
          step_count: r.step_count,
          country_code: r.country_code,
        })),
      };
    },
  },
  {
    name: "get_playbook",
    description: "Look up a single playbook with all its steps.",
    parameters: {
      type: "object",
      properties: { playbookId: { type: "string" } },
      required: ["playbookId"],
    },
    async handler(ctx, args) {
      const id = str(args.playbookId);
      if (!id) return { error: "playbookId is required" };
      const playbook = await findPlaybookById(ctx.companyId, id);
      return { playbook };
    },
  },
  {
    name: "list_agent_runs",
    description:
      "List Financial-Agent runs (the AI classifier+tax+plan stack), filterable by status (pending_review, auto_approved, approved, executed, rejected).",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [
            "pending_review",
            "auto_approved",
            "approved",
            "executed",
            "rejected",
          ],
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      const validStatuses: AgentRunStatus[] = [
        "pending_review",
        "auto_approved",
        "approved",
        "executed",
        "rejected",
      ];
      const status = str(args.status);
      const rows = await listAgentRuns({
        companyId: ctx.companyId,
        status:
          status && (validStatuses as string[]).includes(status)
            ? (status as AgentRunStatus)
            : undefined,
        limit: num(args.limit) ?? 50,
      });
      return { runs: rows };
    },
  },
  {
    name: "get_agent_run",
    description: "Look up a single Financial-Agent run with its full classification, tax-reasoning, action plan, and approval decision.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const run = await getAgentRunById(ctx.companyId, id);
      return { run };
    },
  },
  {
    name: "list_schedules",
    description: "List the company's scheduled (cron) playbook runs.",
    parameters: { type: "object", properties: {} },
    async handler(ctx) {
      const rows = await listScheduledRuns(ctx.companyId);
      return { schedules: rows };
    },
  },
  {
    name: "get_schedule",
    description: "Look up a single scheduled run.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const schedule = await findScheduledRunById(ctx.companyId, id);
      return { schedule };
    },
  },
  {
    name: "list_recent_bulk_runs",
    description: "List the company's recent bulk runs, newest first, with summary counts.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    async handler(ctx, args) {
      const rows = await listBulkRuns(ctx.companyId, num(args.limit) ?? 30);
      return { runs: rows };
    },
  },

  // Alerts (Slice B) ──
  {
    name: "list_alerts",
    description:
      "List the company's open alerts (failures the system flagged for attention). Use status='open' for the active queue, 'acknowledged' for in-progress, 'resolved' for closed.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "acknowledged", "resolved", "snoozed"],
        },
        severity: { type: "string", enum: ["info", "warn", "critical"] },
        entityType: { type: "string", description: "e.g. 'bulk_run', 'waybill'" },
        entityId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      const status = str(args.status) as AlertStatus | undefined;
      const severity = str(args.severity);
      const validSev = ["info", "warn", "critical"] as const;
      const rows = await listAlerts({
        companyId: ctx.companyId,
        status,
        severity:
          severity && (validSev as readonly string[]).includes(severity)
            ? (severity as (typeof validSev)[number])
            : undefined,
        entityType: str(args.entityType),
        entityId: str(args.entityId),
        limit: num(args.limit) ?? 50,
      });
      return { alerts: rows };
    },
  },
  {
    name: "get_alert",
    description: "Look up a single alert with its full metadata and suggested actions.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const alert = await getAlertById(ctx.companyId, id);
      return { alert };
    },
  },
  {
    name: "acknowledge_alert",
    description:
      "Mark an alert as acknowledged (someone is working on it). Use after the user says they'll handle it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const alert = await setAlertStatus({
        companyId: ctx.companyId,
        id,
        status: "acknowledged",
        reviewedBy: ctx.userId,
      });
      if (!alert) return { error: "Alert not found" };
      return { alert };
    },
  },
  // ── Write tools (Slice C — gated through Approval Gate) ──
  //
  // Each handler delegates to runWriteTool, which evaluates the
  // Approval Gate and either runs the mutation immediately (when safe)
  // or persists it as a pending_review row in agent_runs (when not).
  // The chat brain verbalises the outcome; the alerts UI also uses
  // the same dispatch endpoint and renders {status, agentRunId}.
  {
    name: "retry_bulk_row",
    description:
      "Re-queue a single failed bulk-run row for retry. Auto-approved when the row's last error matches a transient pattern (timeout, ECONNRESET, rate limit, 5xx). Otherwise queues for human approval.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
        rowIndex: { type: "integer", minimum: 0 },
      },
      required: ["runId", "rowIndex"],
    },
    async handler(ctx, args) {
      const runId = str(args.runId);
      const rowIndex = num(args.rowIndex);
      if (!runId || typeof rowIndex !== "number") {
        return { error: "runId and rowIndex are required" };
      }
      const outcome = await runWriteTool(
        {
          name: "retry_bulk_row",
          describe: (a) => `retry bulk row ${a.runId}:${a.rowIndex}`,
          reversible: () => true, // requeue is idempotent
          async autoApprove(a, c) {
            // Auto-approve when the existing row.error matches a
            // transient regex bucket. Reads the row directly so we
            // never auto-fire on stale assumptions.
            const r = await query<{ error: string | null }>(
              `SELECT r.error
                 FROM bulk_run_rows r
                 JOIN bulk_runs br ON br.id = r.run_id
                WHERE br.company_id = $1 AND r.run_id = $2 AND r.row_index = $3
                LIMIT 1`,
              [c.companyId, a.runId, a.rowIndex],
            );
            const errText = r.rows[0]?.error ?? "";
            const cls = classifyErrorText(errText);
            return cls === "network" || cls === "timeout" || cls === "rate_limit" || cls === "portal_error";
          },
          async execute(a, c) {
            // Tenant guard: confirm the row belongs to the company.
            const owned = await findBulkRun(c.companyId, a.runId);
            if (!owned) throw new Error(`Run ${a.runId} not found`);
            const attempt = await requeueRowForRetry(a.runId, a.rowIndex);
            if (attempt === null) {
              throw new Error(`Row ${a.runId}:${a.rowIndex} not retryable`);
            }
            return { runId: a.runId, rowIndex: a.rowIndex, attemptCount: attempt };
          },
        },
        { runId, rowIndex },
        ctx,
      );
      return outcome;
    },
  },
  {
    name: "retry_bulk_failed",
    description:
      "Re-queue ALL failed rows in a bulk run. Large blast radius — always queues for human approval.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    async handler(ctx, args) {
      const runId = str(args.runId);
      if (!runId) return { error: "runId is required" };
      return runWriteTool(
        {
          name: "retry_bulk_failed",
          describe: (a) => `retry all failed rows in bulk run ${a.runId}`,
          reversible: () => false, // many rows; effect compounds
          async execute(a, c) {
            const owned = await findBulkRun(c.companyId, a.runId);
            if (!owned) throw new Error(`Run ${a.runId} not found`);
            const reset = await resetIncompleteRows(a.runId);
            return { runId: a.runId, rowsReset: reset };
          },
        },
        { runId },
        ctx,
      );
    },
  },
  {
    name: "retry_operation_item",
    description:
      "Re-trigger a single operations item (e.g. a single waybill shipment) through the rs-server pipeline. Idempotent — auto-approved.",
    parameters: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
    },
    async handler(ctx, args) {
      const itemId = str(args.itemId);
      if (!itemId) return { error: "itemId is required" };
      return runWriteTool(
        {
          name: "retry_operation_item",
          describe: (a) => `retry operation item ${a.itemId}`,
          reversible: () => true,
          async autoApprove() {
            return true; // existing endpoint is idempotent
          },
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/operations/items/${encodeURIComponent(a.itemId)}/retry`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { itemId },
        ctx,
      );
    },
  },
  {
    name: "trigger_pipeline",
    description:
      "Manually trigger a pipeline run on rs-server. Queues for approval because it can kick rs.ge submissions.",
    parameters: {
      type: "object",
      properties: { pipelineId: { type: "string" } },
      required: ["pipelineId"],
    },
    async handler(ctx, args) {
      const pipelineId = str(args.pipelineId);
      if (!pipelineId) return { error: "pipelineId is required" };
      return runWriteTool(
        {
          name: "trigger_pipeline",
          describe: (a) => `trigger pipeline ${a.pipelineId}`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/pipelines/${encodeURIComponent(a.pipelineId)}/trigger`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { pipelineId },
        ctx,
      );
    },
  },
  {
    name: "skip_bulk_row",
    description:
      "Mark a single failed bulk-run row as skipped with a reason. Data-loss-ish — always queues for approval.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
        rowIndex: { type: "integer", minimum: 0 },
        reason: { type: "string", description: "why the row is being skipped" },
      },
      required: ["runId", "rowIndex", "reason"],
    },
    async handler(ctx, args) {
      const runId = str(args.runId);
      const rowIndex = num(args.rowIndex);
      const reason = str(args.reason);
      if (!runId || typeof rowIndex !== "number" || !reason) {
        return { error: "runId, rowIndex, and reason are required" };
      }
      return runWriteTool(
        {
          name: "skip_bulk_row",
          describe: (a) => `skip bulk row ${a.runId}:${a.rowIndex} (${a.reason})`,
          reversible: () => false,
          async execute(a, c) {
            const owned = await findBulkRun(c.companyId, a.runId);
            if (!owned) throw new Error(`Run ${a.runId} not found`);
            const updated = await skipBulkRow(a.runId, a.rowIndex, a.reason);
            if (!updated) {
              throw new Error(
                `Row ${a.runId}:${a.rowIndex} not skippable (must be pending or failed)`,
              );
            }
            return { runId: a.runId, rowIndex: a.rowIndex, status: updated.status };
          },
        },
        { runId, rowIndex, reason },
        ctx,
      );
    },
  },
  // amend_declaration is intentionally NOT executed automatically —
  // editing tax filings is the highest-risk fix in the catalog, and
  // the actual amend path on rs-server doesn't exist yet. Today this
  // tool ALWAYS queues for human review, surfacing the intent in
  // /dashboard/ai/approvals where an accountant can amend by hand.
  {
    name: "amend_declaration",
    description:
      "Request an amendment to a declaration (e.g. fix a TIN, correct an amount). Always queues for human review — declario does not auto-edit tax filings.",
    parameters: {
      type: "object",
      properties: {
        declarationId: { type: "string" },
        patch: { type: "object", description: "fields to amend" },
      },
      required: ["declarationId", "patch"],
    },
    async handler(ctx, args) {
      const declarationId = str(args.declarationId);
      const patch =
        args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
          ? (args.patch as Record<string, unknown>)
          : null;
      if (!declarationId || !patch) {
        return { error: "declarationId and patch are required" };
      }
      return runWriteTool(
        {
          name: "amend_declaration",
          describe: (a) =>
            `amend declaration ${a.declarationId}: ${Object.keys(
              (a.patch as Record<string, unknown>) ?? {},
            ).join(", ")}`,
          reversible: () => false,
          async execute() {
            // Always queues; this branch only fires if the gate
            // policy ever flips. Keep it explicit so a future
            // operator never auto-amends by accident.
            throw new Error(
              "amend_declaration must always go through human approval — auto-execute is disabled by design.",
            );
          },
        },
        { declarationId, patch },
        ctx,
      );
    },
  },

  {
    name: "snooze_alert",
    description:
      "Snooze an alert for N hours. Useful when the user wants to deal with it later — it'll reappear after the snooze expires unless the underlying issue resolved itself.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        hours: { type: "number", minimum: 1, maximum: 720 },
      },
      required: ["id", "hours"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      const hours = num(args.hours);
      if (!id) return { error: "id is required" };
      if (!hours || hours <= 0) return { error: "hours must be a positive number" };
      const until = new Date(Date.now() + hours * 3600_000).toISOString();
      const alert = await setAlertStatus({
        companyId: ctx.companyId,
        id,
        status: "snoozed",
        snoozedUntil: until,
        reviewedBy: ctx.userId,
      });
      if (!alert) return { error: "Alert not found" };
      return { alert };
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────────

const toolByName = new Map(CHAT_TOOLS.map((t) => [t.name, t]));

/**
 * Function declarations as accepted by `geminiService.generateWithTools`.
 * Keep this in sync with `CHAT_TOOLS` automatically.
 */
export function toolDeclarations(): FunctionDeclaration[] {
  return CHAT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as never,
  }));
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<unknown> {
  const tool = toolByName.get(name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.handler(ctx, args);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The system instruction shown to the model when chat tools are enabled.
 * Names the available tools and the rules for when to call them.
 */
export function chatToolSystemInstruction(): string {
  const lines = CHAT_TOOLS.map(
    (t) => `- ${t.name}: ${t.description}`,
  ).join("\n");
  return [
    "You are declario's chat assistant for accountants and SMB owners.",
    "When the user asks about live data — a specific waybill, declaration, pipeline run, bulk run, order, schedule, playbook, or AI run, or about why something failed — CALL ONE OF THE TOOLS BELOW first. Do not fabricate IDs, statuses, or error reasons. If you need data, ask the tool; if the tool returns nothing or an error, say so plainly.",
    "Computing THE COMPANY'S OWN VAT (დღგ) for a period is LIVE DATA, not a general question. You MUST call `draft_vat_return` whenever the user asks to compute/draft/prepare/explain THEIR OWN VAT for a month (e.g. 'ჩვენი/ჩემი დღგ', 'დღგ დამიდგინე/გამოთვალე', 'how much VAT do we owe this month') and base every VAT figure strictly on the tool's result, reading out any warnings it returns. Do NOT call the tool for GENERAL VAT questions — the rate, definitions, or how the rules work — answer those from the knowledge base instead. There is no computation tool yet for payroll or profit tax: for those, explain from the knowledge base and say a calculation tool isn't available yet — do NOT call draft_vat_return for them.",
    "When the user asks a general accounting/tax-code question (definitions, how a rule works, what the law says — not their own numbers), answer from your training and the RAG context (no tool call needed), citing the relevant articles.",
    "After tool results come back, write a concise human answer. Quote specific IDs and short error excerpts so the user can navigate to the right page.",
    "Available tools:",
    lines,
  ].join("\n\n");
}

/**
 * Cheap regex that says "this message is about live data and we should
 * skip the expensive RAG embed on the first turn." Tool-calling will
 * still happen either way; this just avoids burning an embedding call.
 */
export function looksLikeDiagnosticQuery(text: string): boolean {
  // Live-data lookups (waybills/declarations/…) AND company-own computations
  // (e.g. "compute our VAT for May") skip the RAG embed and go straight to the
  // tool loop: their answer lives in live data + tools, not the book corpus,
  // and a noisy RAG context otherwise distracts the model from calling the
  // tool. General tax questions ("what is the VAT rate") still go through RAG.
  if (
    /\b(waybill|declaration|pipeline|bulk|failed|retry|alert|error|status|order|playbook|schedule|run)\b|#\d+/i.test(
      text,
    )
  ) {
    return true;
  }
  const mentionsVat = /(დღგ|\bvat\b)/i.test(text);
  const computeIntent =
    /(გამოთვალ|დამიდგ|რამდენ|გადასახდ|დეკლარაცი|ჩვენ|ჩემ|draft|compute|prepare|owe|how much)/i.test(
      text,
    );
  return mentionsVat && computeIntent;
}
