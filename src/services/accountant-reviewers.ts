import type { GeminiService } from "./gemini";
import {
  expectBoolean,
  expectNumber,
  expectObject,
  expectString,
  expectStringArray,
  runStructuredAgent,
  type StructuredAgentResult,
  type StructuredAgentSpec,
} from "./structured-agent";

export interface AccountantReviewOutput {
  summary: string;
  findings: string[];
  risks: string[];
  recommended_actions: string[];
  citations: string[];
  ready: boolean;
  confidence: number;
  warnings: string[];
}

type ReviewerKind = "reconciliation" | "tax_workpaper" | "filing_readiness";

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    recommended_actions: { type: "array", items: { type: "string" } },
    citations: { type: "array", items: { type: "string" } },
    ready: { type: "boolean" },
    confidence: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "findings",
    "risks",
    "recommended_actions",
    "citations",
    "ready",
    "confidence",
    "warnings",
  ],
};

function systemPrompt(kind: ReviewerKind) {
  const focus: Record<ReviewerKind, string> = {
    reconciliation:
      "Review bank/invoice/order/waybill/journal matching. Identify unmatched items, duplicate candidates, partial payments, refunds, timing differences, and confidence risks.",
    tax_workpaper:
      "Review VAT/payroll/profit-tax workpaper data. Check source completeness, calculation consistency, period cut-off, deductible input VAT eligibility, and citations.",
    filing_readiness:
      "Decide whether a tax filing is ready to submit. Treat irreversible portal submissions conservatively. Block filing if snapshots are stale, approvals are missing, blockers remain, or evidence is incomplete.",
  };
  return `You are Declario's ${kind} reviewer for Georgian SME accounting.

${focus[kind]}

Rules:
1. Do NOT execute tools, create journal entries, file declarations, or mutate data.
2. Use only the payload and reference/citation strings provided by the caller.
3. If a legal/tax conclusion is not grounded in payload references, lower confidence and add a warning.
4. Respond in concise Georgian accountant language when possible.
5. Output ONE valid JSON object. No markdown. No prose.`;
}

function spec(kind: ReviewerKind): StructuredAgentSpec<AccountantReviewOutput> {
  return {
    key: `${kind}-reviewer-v1`,
    systemPrompt: systemPrompt(kind),
    responseSchema: RESPONSE_SCHEMA,
    temperature: 0.1,
    maxOutputTokens: 1536,
    maxRetries: 1,
    validate(raw: unknown): AccountantReviewOutput {
      const obj = expectObject(raw, `${kind}_review`);
      return {
        summary: expectString(obj.summary, `${kind}_review.summary`),
        findings: expectStringArray(obj.findings, `${kind}_review.findings`),
        risks: expectStringArray(obj.risks, `${kind}_review.risks`),
        recommended_actions: expectStringArray(
          obj.recommended_actions,
          `${kind}_review.recommended_actions`,
        ),
        citations: expectStringArray(obj.citations, `${kind}_review.citations`),
        ready: expectBoolean(obj.ready, `${kind}_review.ready`),
        confidence: expectNumber(obj.confidence, `${kind}_review.confidence`),
        warnings: expectStringArray(obj.warnings, `${kind}_review.warnings`),
      };
    },
  };
}

export function reviewReconciliation(
  payload: Record<string, unknown>,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<AccountantReviewOutput>> {
  return runStructuredAgent(spec("reconciliation"), { payload }, opts);
}

export function reviewTaxWorkpaper(
  payload: Record<string, unknown>,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<AccountantReviewOutput>> {
  return runStructuredAgent(spec("tax_workpaper"), { payload }, opts);
}

export function reviewFilingReadiness(
  payload: Record<string, unknown>,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<AccountantReviewOutput>> {
  return runStructuredAgent(spec("filing_readiness"), { payload }, opts);
}
