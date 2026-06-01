// "needs_review" = submitted but the confirmation page couldn't be visually
// verified (deterministic checks passed). It is a success outcome flagged for a
// quick human glance — never a failure.
export type ExecutionCompletionState =
  | "ready_for_review"
  | "submitted"
  | "failed"
  | "needs_review";

export type SafetyMode = "auto" | "halt-on-dangerous" | "dry-run";

export const EXECUTION_COMPLETION_STATES: ExecutionCompletionState[] = [
  "ready_for_review",
  "submitted",
  "failed",
  "needs_review",
];

export const SAFETY_MODES: SafetyMode[] = ["auto", "halt-on-dangerous", "dry-run"];

export function isCompletionState(value: unknown): value is ExecutionCompletionState {
  return typeof value === "string" && EXECUTION_COMPLETION_STATES.includes(value as ExecutionCompletionState);
}

export function isSafetyMode(value: unknown): value is SafetyMode {
  return typeof value === "string" && SAFETY_MODES.includes(value as SafetyMode);
}
