import {
  evaluateApproval,
  type ApprovalDecision,
} from "./approval-gate";
import { insertAgentRun } from "../repositories/agentRuns";
import type { FinancialAgentStackResult } from "./financial-agent-stack";
import type { ToolCallContext } from "./chat-tools";

/**
 * Gate-wrapper for chat-tool writes (Slice C).
 *
 * Every write tool calls `runWriteTool(spec, ...)` instead of executing
 * its mutation directly. The wrapper:
 *
 *   1. Builds an `ApprovalContext` from the tool's declared properties
 *      (reversible, transient retry, irreversible side-effects).
 *   2. Calls `evaluateApproval` — the same deterministic rule engine
 *      the Financial Agent Stack uses, so a single safety policy
 *      governs both AI-driven plans and chat-driven fixes.
 *   3. If approved, runs the mutation immediately and surfaces the
 *      decision summary so the chat brain can verbalise it
 *      ("Auto-approved — retrying row 47").
 *   4. If blocked, persists the intent as an `agent_runs` row with
 *      `status='pending_review'` so it shows up in the existing
 *      /dashboard/ai/approvals queue. Returns the run id so the chat
 *      can deep-link the user.
 *
 * The `agent_runs` insert uses a synthetic FinancialAgentStackResult
 * because that's the shape the table + the queue UI already
 * understand. Each "chat tool fix" becomes a queue card with the tool
 * name + args visible, the gate flags listed, and an audit trail —
 * the same surface that already handles Financial Agent Stack runs.
 */

export interface WriteToolSpec<TArgs extends Record<string, unknown>, TResult> {
  /** Tool name surfaced to the model (e.g. "retry_bulk_row"). */
  name: string;
  /** Short human-readable verb form for chat replies, e.g. "retry bulk row 7". */
  describe: (args: TArgs) => string;
  /** True if the underlying mutation cannot be undone once it runs. */
  reversible: (args: TArgs) => boolean;
  /**
   * Per-args fast-path: if the predicate returns true, the gate
   * is bypassed and the mutation runs immediately. Use for
   * transient-error retries (timeouts, ECONNRESET, 5xx) where we'd
   * rather just retry than block the user behind an approval.
   * Returns undefined to let the normal gate logic decide.
   */
  autoApprove?: (args: TArgs, ctx: ToolCallContext) => Promise<boolean>;
  /** The mutation itself, executed only after the gate clears. */
  execute: (args: TArgs, ctx: ToolCallContext) => Promise<TResult>;
}

export type WriteToolOutcome<TResult> =
  | { status: "executed"; summary: string; result: TResult }
  | { status: "queued_for_approval"; summary: string; agentRunId: string; flags: ApprovalDecision["flags"] }
  | { status: "error"; error: string };

function syntheticResult(
  spec: WriteToolSpec<never, never>,
  args: Record<string, unknown>,
  decision: ApprovalDecision,
): FinancialAgentStackResult {
  // The classifier/tax/planner agents don't run for chat tools — we
  // stub minimal valid outputs so insertAgentRun + the Approval Queue
  // UI render the row without special-casing. The diagnostic value of
  // the row is in `operation` + `approval`, not the stubs.
  return {
    classification: {
      output: {
        category: "tool_action" as never,
        description: `Chat tool fix: ${spec.name}`,
        vat_applicable: false,
        vat_amount: 0,
        deductible: false,
        ledger_entries: [],
        confidence: 1,
        warnings: [],
      },
      confidence: 1,
      warnings: [],
      model: "chat-tool-write",
      attempts: 1,
      latencyMs: 0,
      rawText: "",
    },
    taxReasoning: {
      output: {
        vat_status: "out_of_scope" as never,
        tax_risk: "none",
        declaration_effect: "no_effect" as never,
        recommended_action: "submit_after_review" as never,
        reasoning: "Chat tool fix queued for human review.",
        warnings: [],
        confidence: 1,
      },
      confidence: 1,
      warnings: [],
      model: "chat-tool-write",
      attempts: 1,
      latencyMs: 0,
      rawText: "",
    },
    actionPlan: {
      output: {
        actions: [
          {
            type: "request_documentation",
            priority: "high",
            playbook_key: "none",
            mcp_server: "none",
            mcp_tool_name: spec.name,
            mcp_args: args,
            mcp_read_only: false,
            requires_confirmation: true,
            country_code: "GE",
            description: spec.describe(args as never),
            required_inputs: [],
            reversible: spec.reversible(args as never),
          },
        ],
        plan_rationale: `Chat tool dispatch: ${spec.name}`,
        warnings: [],
        confidence: 1,
      },
      confidence: 1,
      warnings: [],
      model: "chat-tool-write",
      attempts: 1,
      latencyMs: 0,
      rawText: "",
    },
    approval: decision,
    summary: {
      approved: decision.approved,
      confidence: 1,
      taxRisk: "none",
      actionCount: 1,
      mcpActionCount: 0,
      requiresConfirmation: true,
      hasIrreversibleActions: !spec.reversible(args as never),
    },
  };
}

export async function runWriteTool<
  TArgs extends Record<string, unknown>,
  TResult,
>(
  spec: WriteToolSpec<TArgs, TResult>,
  args: TArgs,
  ctx: ToolCallContext,
): Promise<WriteToolOutcome<TResult>> {
  // Fast-path for transient retries: skip the gate entirely.
  if (spec.autoApprove) {
    try {
      if (await spec.autoApprove(args, ctx)) {
        const result = await spec.execute(args, ctx);
        return {
          status: "executed",
          summary: `Auto-approved (transient): ${spec.describe(args)}`,
          result,
        };
      }
    } catch (err) {
      // Fast-path lookup failures should NOT block the user — fall through
      // to the normal gate. They'll just get a slightly slower path.
      console.warn(
        `[runWriteTool ${spec.name}] autoApprove probe failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const reversible = spec.reversible(args);
  const decision = evaluateApproval(
    { confidence: 1, warnings: [] },
    {
      hasIrreversibleActions: !reversible,
      taxRisk: "none",
    },
  );

  if (decision.approved) {
    const result = await spec.execute(args, ctx);
    return {
      status: "executed",
      summary: decision.summary,
      result,
    };
  }

  // Blocked → persist as a pending_review agent_run so it surfaces in
  // /dashboard/ai/approvals. The operation column carries the tool
  // identity so the queue card shows what's being asked.
  let agentRunId = "";
  try {
    const stub = syntheticResult(
      spec as never,
      args as Record<string, unknown>,
      decision,
    );
    const row = await insertAgentRun({
      companyId: ctx.companyId,
      operation: {
        kind: "chat_tool_fix",
        tool: spec.name,
        args,
        requested_by: ctx.userId ?? null,
        description: spec.describe(args),
      },
      amount: null,
      currency: null,
      result: stub,
    });
    agentRunId = row.id;
  } catch (err) {
    return {
      status: "error",
      error: `Approval queue write failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  return {
    status: "queued_for_approval",
    summary: decision.summary,
    agentRunId,
    flags: decision.flags,
  };
}
