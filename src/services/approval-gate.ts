import type { StructuredAgentResult } from "./structured-agent";

/**
 * Agent #4 — Human Approval Layer.
 *
 * This is intentionally NOT an LLM. It's a deterministic rule engine that
 * sits between every structured agent's output and any side effect
 * (declaration submission, RS.ge action, journal entry posting). The
 * Approval Gate decides one thing: "is this safe to execute without a
 * human review, or does it have to wait?"
 *
 * The five rules wired here mirror the planning prompt:
 *   1. confidence < threshold        → require approval
 *   2. tax risk in {medium, high}    → require approval
 *   3. unusual amount vs prev period → require approval
 *   4. declaration delta > threshold → require approval
 *   5. explicit agent warnings       → flag, optionally block
 *
 * Rules return a `severity` of "info" | "warn" | "block". Only "block"
 * actually requires human approval; "warn" surfaces to the user but
 * doesn't gate execution. Callers compose the decision: a single block
 * fails the gate; otherwise it passes.
 *
 * The gate ALSO returns a single human-readable summary line so the chat
 * brain can say things like "I held this one — confidence 0.72 is below
 * the 0.9 threshold for tax filings."
 */

export type ApprovalSeverity = "info" | "warn" | "block";
export type TaxRisk = "none" | "low" | "medium" | "high";

export type ApprovalFlagKind =
  | "low_confidence"
  | "agent_warning"
  | "tax_risk"
  | "irreversible_action"
  | "unusual_amount"
  | "declaration_delta"
  | "no_previous_period_data";

export interface ApprovalFlag {
  kind: ApprovalFlagKind;
  severity: ApprovalSeverity;
  detail: string;
}

export interface ApprovalDecision {
  /** True when no `block`-severity flag fired. False = must wait for human. */
  approved: boolean;
  /** Human-readable summary line for chat / UI surfaces. */
  summary: string;
  /** Every flag that fired, ordered by severity (block first). */
  flags: ApprovalFlag[];
}

export interface ApprovalPolicy {
  /** Below this confidence, require human approval. Default 0.9. */
  confidenceThreshold?: number;
  /** Tax risk levels that require approval. Default ["medium", "high"]. */
  blockOnTaxRisk?: TaxRisk[];
  /**
   * If the operation's amount is more than this multiplier × previous-period
   * median, flag as unusual. Default 2.0. Set to 0 to disable.
   */
  unusualAmountMultiplier?: number;
  /**
   * If a declaration's projected total differs from the previous period by
   * more than this fraction (0.5 = 50%), require approval. Default 0.5.
   */
  declarationDeltaThreshold?: number;
  /**
   * If true, warnings from the agent are escalated to "block" rather than
   * "warn". Useful for tax-filing flows where any agent warning is a stop.
   * Default false.
   */
  blockOnAgentWarnings?: boolean;
  /**
   * If true, any non-reversible portal action requires human approval.
   * Default true because RS.ge submit/send operations can create external
   * records that should not be fired solely on model confidence.
   */
  blockOnIrreversibleActions?: boolean;
}

const DEFAULT_POLICY: Required<ApprovalPolicy> = {
  confidenceThreshold: 0.9,
  blockOnTaxRisk: ["medium", "high"],
  unusualAmountMultiplier: 2.0,
  declarationDeltaThreshold: 0.5,
  blockOnAgentWarnings: false,
  blockOnIrreversibleActions: true,
};

export interface ApprovalContext {
  /** The operation's amount in its native currency (for anomaly check). */
  amount?: number;
  /**
   * Median amount of recent operations in the same category, in the same
   * currency. If undefined, the unusual-amount rule emits a "no previous
   * period data" info flag and does not block.
   */
  previousPeriodMedian?: number;
  /**
   * Total of the projected declaration after this operation, in the
   * company's base currency. Compared against `previousDeclarationTotal`.
   */
  projectedDeclarationTotal?: number;
  /** Total of the previous period's declaration in the same currency. */
  previousDeclarationTotal?: number;
  /** Tax risk reported by the Tax Reasoning agent (#2). */
  taxRisk?: TaxRisk;
  /** True when a planned RS action cannot be safely undone. */
  hasIrreversibleActions?: boolean;
}

/**
 * Evaluate any structured agent's output against the approval policy.
 *
 * Generic over the agent's `output` type so the chat / classifier / tax
 * reasoning / RS planner can all feed it. The runner returns confidence +
 * warnings on every result, which is what the gate actually reads.
 */
export function evaluateApproval<TOutput>(
  agentResult: Pick<StructuredAgentResult<TOutput>, "confidence" | "warnings">,
  context: ApprovalContext = {},
  policy: ApprovalPolicy = {},
): ApprovalDecision {
  const p: Required<ApprovalPolicy> = { ...DEFAULT_POLICY, ...policy };
  const flags: ApprovalFlag[] = [];

  // Rule 1 — confidence
  if (agentResult.confidence < p.confidenceThreshold) {
    flags.push({
      kind: "low_confidence",
      severity: "block",
      detail: `Confidence ${agentResult.confidence.toFixed(2)} is below the ${p.confidenceThreshold} threshold.`,
    });
  }

  // Rule 2 — tax risk
  if (
    context.taxRisk &&
    context.taxRisk !== "none" &&
    p.blockOnTaxRisk.includes(context.taxRisk)
  ) {
    flags.push({
      kind: "tax_risk",
      severity: "block",
      detail: `Tax risk reported as "${context.taxRisk}".`,
    });
  } else if (context.taxRisk === "low") {
    flags.push({
      kind: "tax_risk",
      severity: "warn",
      detail: 'Tax risk reported as "low" — proceeding, but documenting in the audit trail.',
    });
  }

  // Rule 2b — irreversible side effects
  if (context.hasIrreversibleActions && p.blockOnIrreversibleActions) {
    flags.push({
      kind: "irreversible_action",
      severity: "block",
      detail: "Plan contains a non-reversible portal action and must be reviewed before execution.",
    });
  }

  // Rule 3 — unusual amount vs previous-period median
  if (typeof context.amount === "number" && p.unusualAmountMultiplier > 0) {
    if (typeof context.previousPeriodMedian === "number" && context.previousPeriodMedian > 0) {
      const ratio = context.amount / context.previousPeriodMedian;
      if (ratio >= p.unusualAmountMultiplier) {
        flags.push({
          kind: "unusual_amount",
          severity: "block",
          detail: `Amount ${context.amount.toFixed(2)} is ${ratio.toFixed(1)}× the previous-period median ${context.previousPeriodMedian.toFixed(2)}.`,
        });
      } else if (ratio >= p.unusualAmountMultiplier * 0.6) {
        flags.push({
          kind: "unusual_amount",
          severity: "warn",
          detail: `Amount ${context.amount.toFixed(2)} is ${ratio.toFixed(1)}× the previous-period median; worth a glance.`,
        });
      }
    } else {
      flags.push({
        kind: "no_previous_period_data",
        severity: "info",
        detail: "No previous-period median available — unusual-amount check skipped.",
      });
    }
  }

  // Rule 4 — declaration delta
  if (
    typeof context.projectedDeclarationTotal === "number" &&
    typeof context.previousDeclarationTotal === "number" &&
    context.previousDeclarationTotal > 0
  ) {
    const delta = Math.abs(
      context.projectedDeclarationTotal - context.previousDeclarationTotal,
    );
    const fraction = delta / context.previousDeclarationTotal;
    if (fraction >= p.declarationDeltaThreshold) {
      flags.push({
        kind: "declaration_delta",
        severity: "block",
        detail: `Declaration total changed by ${(fraction * 100).toFixed(0)}% vs the previous period.`,
      });
    } else if (fraction >= p.declarationDeltaThreshold * 0.6) {
      flags.push({
        kind: "declaration_delta",
        severity: "warn",
        detail: `Declaration total changed by ${(fraction * 100).toFixed(0)}% vs the previous period; review before submit.`,
      });
    }
  }

  // Rule 5 — agent warnings (always at least a flag; block if policy says so)
  if (agentResult.warnings.length > 0) {
    const severity: ApprovalSeverity = p.blockOnAgentWarnings ? "block" : "warn";
    flags.push({
      kind: "agent_warning",
      severity,
      detail: agentResult.warnings.join("; "),
    });
  }

  // Sort flags: block → warn → info (so the UI can show blockers first).
  const order: Record<ApprovalSeverity, number> = { block: 0, warn: 1, info: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  const approved = !flags.some((f) => f.severity === "block");
  const blockers = flags.filter((f) => f.severity === "block");
  const summary = approved
    ? flags.length === 0
      ? "Auto-approved: all checks clean."
      : `Auto-approved with ${flags.length} non-blocking note(s).`
    : `Held for human review: ${blockers.map((f) => f.kind).join(", ")}.`;

  return { approved, summary, flags };
}
