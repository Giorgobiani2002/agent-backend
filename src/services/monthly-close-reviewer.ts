import { GeminiService } from "./gemini";
import {
  expectNumber,
  expectObject,
  expectString,
  expectStringArray,
  runStructuredAgent,
  type StructuredAgentResult,
  type StructuredAgentSpec,
} from "./structured-agent";

export interface MonthlyCloseReviewOutput {
  summary: string;
  risks: string[];
  missing_documents: string[];
  recommended_actions: string[];
  confidence: number;
  warnings: string[];
}

const SYSTEM_PROMPT = `You are Declario's monthly-close reviewer for Georgian SME accounting.

You receive a deterministic monthly close payload that was computed by code:
posted journal counters, bank reconciliation, VAT snapshot, existing VAT declaration state,
and exception flags.

Rules:
1. Do NOT create journal entries, VAT declarations, or portal actions.
2. Do NOT invent data that is not in the payload.
3. Explain the close status in Georgian, in concise accountant language.
4. Treat blocker exceptions as not ready to file.
5. Recommended actions must be operational next steps, not legal advice.
6. Output ONE valid JSON object. No prose. No markdown fences.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    summary: { type: "string" },
    risks: { type: "array", items: { type: "string" } },
    missing_documents: { type: "array", items: { type: "string" } },
    recommended_actions: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "summary",
    "risks",
    "missing_documents",
    "recommended_actions",
    "confidence",
    "warnings",
  ],
};

export const monthlyCloseReviewerAgent: StructuredAgentSpec<MonthlyCloseReviewOutput> = {
  key: "monthly-close-reviewer-v1",
  systemPrompt: SYSTEM_PROMPT,
  responseSchema: RESPONSE_SCHEMA,
  temperature: 0.1,
  maxOutputTokens: 1536,
  maxRetries: 1,
  validate(raw: unknown): MonthlyCloseReviewOutput {
    const obj = expectObject(raw, "monthly_close_review");
    return {
      summary: expectString(obj.summary, "monthly_close_review.summary"),
      risks: expectStringArray(obj.risks, "monthly_close_review.risks"),
      missing_documents: expectStringArray(
        obj.missing_documents,
        "monthly_close_review.missing_documents",
      ),
      recommended_actions: expectStringArray(
        obj.recommended_actions,
        "monthly_close_review.recommended_actions",
      ),
      confidence: expectNumber(obj.confidence, "monthly_close_review.confidence"),
      warnings: expectStringArray(obj.warnings, "monthly_close_review.warnings"),
    };
  },
};

export function reviewMonthlyClose(
  payload: Record<string, unknown>,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<MonthlyCloseReviewOutput>> {
  return runStructuredAgent(
    monthlyCloseReviewerAgent,
    {
      payload,
    },
    opts,
  );
}
