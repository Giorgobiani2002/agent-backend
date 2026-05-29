import { evaluateApproval, type ApprovalContext, type ApprovalDecision, type ApprovalPolicy } from "./approval-gate";
import { classifyOperation, type ClassifierOutput } from "./classifier";
import type { GeminiService } from "./gemini";
import { planRsActions, type RsActionPlannerOutput } from "./rs-action-planner";
import type { StructuredAgentInput, StructuredAgentResult } from "./structured-agent";
import { reasonAboutTax, type TaxReasoningOutput } from "./tax-reasoning";

/**
 * End-to-end AI agent stack:
 *   operation -> Accounting Classifier -> Georgian Tax Reasoning ->
 *   RS Action Planner -> deterministic Approval Gate.
 *
 * This is the single service API the UI/API should call when it wants a
 * structured, auditable plan for a real financial operation.
 */

export interface FinancialAgentStackInput {
  operation: Record<string, unknown>;
  countryCode?: string;
  ragChunks?: StructuredAgentInput["ragChunks"];
  alreadyDone?: Array<{ type: string; submitted_at: string; reference: string }>;
  approvalContext?: Omit<ApprovalContext, "taxRisk" | "hasIrreversibleActions">;
  approvalPolicy?: ApprovalPolicy;
}

export interface FinancialAgentStackResult {
  classification: StructuredAgentResult<ClassifierOutput>;
  taxReasoning: StructuredAgentResult<TaxReasoningOutput>;
  actionPlan: StructuredAgentResult<RsActionPlannerOutput>;
  approval: ApprovalDecision;
  summary: {
    approved: boolean;
    confidence: number;
    taxRisk: TaxReasoningOutput["tax_risk"];
    actionCount: number;
    mcpActionCount: number;
    requiresConfirmation: boolean;
    hasIrreversibleActions: boolean;
  };
}

export async function analyzeFinancialOperation(
  input: FinancialAgentStackInput,
  opts: { gemini?: GeminiService } = {},
): Promise<FinancialAgentStackResult> {
  const countryCode = input.countryCode ?? "GE";

  const classification = await classifyOperation(
    {
      operation: input.operation,
      ragChunks: input.ragChunks,
    },
    opts,
  );

  const taxReasoning = await reasonAboutTax(
    {
      operation: input.operation,
      classification: classification.output,
      ragChunks: input.ragChunks,
    },
    opts,
  );

  const actionPlan = await planRsActions(
    {
      operation: input.operation,
      classification: classification.output,
      taxReasoning: taxReasoning.output,
      countryCode,
      alreadyDone: normalizeAlreadyDone(input.alreadyDone),
      ragChunks: input.ragChunks,
    },
    opts,
  );

  const hasIrreversibleActions = actionPlan.output.actions.some((action) => !action.reversible);
  const mcpActionCount = actionPlan.output.actions.filter(
    (action) => action.mcp_server !== "none" && action.mcp_tool_name !== "none",
  ).length;
  const requiresConfirmation = actionPlan.output.actions.some(
    (action) => action.requires_confirmation,
  );
  const combinedConfidence = Math.min(
    classification.confidence,
    taxReasoning.confidence,
    actionPlan.confidence,
  );
  const combinedWarnings = [
    ...classification.warnings,
    ...taxReasoning.warnings,
    ...actionPlan.warnings,
  ];

  const approval = evaluateApproval(
    {
      confidence: combinedConfidence,
      warnings: combinedWarnings,
    },
    {
      ...input.approvalContext,
      taxRisk: taxReasoning.output.tax_risk,
      hasIrreversibleActions,
    },
    input.approvalPolicy,
  );

  return {
    classification,
    taxReasoning,
    actionPlan,
    approval,
    summary: {
      approved: approval.approved,
      confidence: combinedConfidence,
      taxRisk: taxReasoning.output.tax_risk,
      actionCount: actionPlan.output.actions.length,
      mcpActionCount,
      requiresConfirmation,
      hasIrreversibleActions,
    },
  };
}

function normalizeAlreadyDone(
  rows: FinancialAgentStackInput["alreadyDone"],
): Array<{ type: never; submitted_at: string; reference: string }> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (row): row is { type: string; submitted_at: string; reference: string } =>
        !!row &&
        typeof row.type === "string" &&
        typeof row.submitted_at === "string" &&
        typeof row.reference === "string",
    )
    .map((row) => ({
      type: row.type as never,
      submitted_at: row.submitted_at,
      reference: row.reference,
    }));
}
