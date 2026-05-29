export type ExecutionCompletionState = "ready_for_review" | "submitted" | "failed";

export type SafetyMode = "auto" | "halt-on-dangerous" | "dry-run";

export const EXECUTION_COMPLETION_STATES: ExecutionCompletionState[] = [
  "ready_for_review",
  "submitted",
  "failed",
];

export const SAFETY_MODES: SafetyMode[] = ["auto", "halt-on-dangerous", "dry-run"];

export function isCompletionState(value: unknown): value is ExecutionCompletionState {
  return typeof value === "string" && EXECUTION_COMPLETION_STATES.includes(value as ExecutionCompletionState);
}

export function isSafetyMode(value: unknown): value is SafetyMode {
  return typeof value === "string" && SAFETY_MODES.includes(value as SafetyMode);
}
