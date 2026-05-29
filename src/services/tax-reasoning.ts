import { GeminiService } from "./gemini";
import {
  expectEnum,
  expectNumber,
  expectObject,
  expectString,
  expectStringArray,
  runStructuredAgent,
  type StructuredAgentInput,
  type StructuredAgentResult,
  type StructuredAgentSpec,
} from "./structured-agent";
import type { ClassifierOutput } from "./classifier";
import type { TaxRisk } from "./approval-gate";

/**
 * Agent #2 — Georgian Tax Reasoning.
 *
 * Input: a classified operation (output of #1 Accounting Classifier) plus
 * optional RAG chunks from the Georgian Tax Code / RS.ge regulations.
 * Output: structured tax judgment — VAT applicability rationale, declared
 * tax risk level, declaration impact, recommended action, warnings.
 *
 * This is the agent that benefits MOST from RAG: every claim it makes
 * should be grounded in a tax-code chunk (the user offered to upload more
 * accounting books — that's the input for this agent). When chunks are
 * provided, the prompt instructs the model to cite them via `[n.k]`.
 *
 * The output's `tax_risk` is the primary input to the Approval Gate's
 * Rule 2. A "high" risk causes the gate to require human approval no
 * matter how high the agent's own confidence is.
 */

// ── Output type ────────────────────────────────────────────────────────────

export type VatStatus =
  | "taxable_standard_18"
  | "taxable_zero"
  | "exempt"
  | "outside_scope"
  | "reverse_charge"
  | "unknown";

export const VAT_STATUSES: readonly VatStatus[] = [
  "taxable_standard_18",
  "taxable_zero",
  "exempt",
  "outside_scope",
  "reverse_charge",
  "unknown",
] as const;

export const TAX_RISK_LEVELS: readonly TaxRisk[] = [
  "none",
  "low",
  "medium",
  "high",
] as const;

export type DeclarationImpact =
  | "increases_vat_payable"
  | "decreases_vat_payable"
  | "increases_input_vat"
  | "no_impact"
  | "shifts_period";

export const DECLARATION_IMPACTS: readonly DeclarationImpact[] = [
  "increases_vat_payable",
  "decreases_vat_payable",
  "increases_input_vat",
  "no_impact",
  "shifts_period",
] as const;

export type RecommendedAction =
  | "submit_now"
  | "submit_after_review"
  | "hold_for_documentation"
  | "do_not_submit"
  | "needs_specialist";

export const RECOMMENDED_ACTIONS: readonly RecommendedAction[] = [
  "submit_now",
  "submit_after_review",
  "hold_for_documentation",
  "do_not_submit",
  "needs_specialist",
] as const;

export interface TaxReasoningOutput {
  vat_status: VatStatus;
  tax_risk: TaxRisk;
  declaration_effect: DeclarationImpact;
  recommended_action: RecommendedAction;
  /** One-paragraph reasoning. Should cite RAG chunks via [n.k] when present. */
  reasoning: string;
  warnings: string[];
  confidence: number;
}

// ── Spec ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior Georgian tax accountant and rs.ge compliance specialist
working inside declario. Your job is to analyse ONE already-classified
operation against Georgian tax law and produce a structured tax
judgment.

ABSOLUTE RULES:
  1. NEVER invent legal facts. If a tax-code chunk is not provided that
     supports a position, say so in warnings and lower confidence.
  2. PREFER conservative tax treatment. When in doubt between "deductible"
     and "not deductible", choose "not deductible" and flag for review.
  3. CITE the reference chunks you used. If REFERENCE chunks are provided
     above the input, cite them inline in \`reasoning\` as [n.k] where n is
     the chunk number and k is the sub-index.
  4. Output ONE valid JSON object. No prose. No markdown fences.

FIELD SEMANTICS:
  - vat_status: which VAT regime the operation falls under in Georgia:
      taxable_standard_18 — normal 18% VAT
      taxable_zero        — zero-rated (exports, certain int'l services)
      exempt              — VAT-exempt supply (financial services, etc.)
      outside_scope       — not within Georgian VAT scope at all
      reverse_charge      — buyer accounts for VAT (import of services)
      unknown             — cannot determine from the inputs
  - tax_risk: how risky this operation is from a compliance perspective:
      none   — textbook operation, no risk
      low    — minor uncertainty, documented in warnings
      medium — material uncertainty OR potential RS.ge audit trigger
      high   — likely RS.ge problem (suspicious counterparty, missing
               supporting docs, related-party at non-market price, etc.)
  - declaration_effect: what this operation does to the next VAT return:
      increases_vat_payable — output VAT goes up
      decreases_vat_payable — adjustment that reduces VAT due
      increases_input_vat   — purchase generates deductible input VAT
      no_impact             — doesn't enter the VAT return
      shifts_period         — affects a different period than the input date
  - recommended_action: the next concrete step:
      submit_now            — safe to submit to RS.ge without review
      submit_after_review   — bookkeeper should review then submit
      hold_for_documentation — missing supporting docs; do not submit yet
      do_not_submit         — should NOT be submitted (e.g. personal expense)
      needs_specialist      — beyond ordinary bookkeeping; escalate
  - reasoning: ONE paragraph. Why this vat_status and tax_risk; cite chunks.
  - warnings: free-form strings the Approval Gate will read.
  - confidence: 0..1. Below 0.7 unless reasoning is grounded in cited chunks.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    vat_status: { type: "string", enum: VAT_STATUSES as unknown as string[] },
    tax_risk: { type: "string", enum: TAX_RISK_LEVELS as unknown as string[] },
    declaration_effect: {
      type: "string",
      enum: DECLARATION_IMPACTS as unknown as string[],
    },
    recommended_action: {
      type: "string",
      enum: RECOMMENDED_ACTIONS as unknown as string[],
    },
    reasoning: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: [
    "vat_status",
    "tax_risk",
    "declaration_effect",
    "recommended_action",
    "reasoning",
    "warnings",
    "confidence",
  ],
};

export const taxReasoningAgent: StructuredAgentSpec<TaxReasoningOutput> = {
  key: "georgian-tax-reasoning-v1",
  systemPrompt: SYSTEM_PROMPT,
  responseSchema: RESPONSE_SCHEMA,
  temperature: 0.1,
  maxOutputTokens: 1024,
  maxRetries: 1,
  validate(raw: unknown): TaxReasoningOutput {
    const obj = expectObject(raw, "tax_reasoning");
    return {
      vat_status: expectEnum(obj.vat_status, VAT_STATUSES, "tax_reasoning.vat_status"),
      tax_risk: expectEnum(obj.tax_risk, TAX_RISK_LEVELS, "tax_reasoning.tax_risk"),
      declaration_effect: expectEnum(
        obj.declaration_effect,
        DECLARATION_IMPACTS,
        "tax_reasoning.declaration_effect",
      ),
      recommended_action: expectEnum(
        obj.recommended_action,
        RECOMMENDED_ACTIONS,
        "tax_reasoning.recommended_action",
      ),
      reasoning: expectString(obj.reasoning, "tax_reasoning.reasoning"),
      warnings: expectStringArray(obj.warnings, "tax_reasoning.warnings"),
      confidence: expectNumber(obj.confidence, "tax_reasoning.confidence"),
    };
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

export interface TaxReasoningInput {
  /** The original classified operation. */
  operation: Record<string, unknown>;
  /** The Classifier's output for this operation. Provides the upstream judgment. */
  classification: ClassifierOutput;
  /** Optional tax-code / RS.ge chunks for grounding. Strongly recommended. */
  ragChunks?: StructuredAgentInput["ragChunks"];
}

export async function reasonAboutTax(
  input: TaxReasoningInput,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<TaxReasoningOutput>> {
  return runStructuredAgent(
    taxReasoningAgent,
    {
      payload: {
        operation: input.operation,
        upstream_classification: input.classification,
      },
      ragChunks: input.ragChunks,
    },
    opts,
  );
}
