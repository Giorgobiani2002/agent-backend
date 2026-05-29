import { GeminiService, geminiService } from "./gemini";

/**
 * Shared infrastructure for every structured (JSON-only) Gemini agent.
 *
 * The five planned agents — Accounting Classifier, Georgian Tax Reasoning,
 * RS Action Planner, Approval Gate, plus the chat brain's tool-calling
 * sub-agents — all share the same shape: a long rules-heavy system prompt,
 * a fixed JSON schema, runtime validation, retry on invalid output, and
 * confidence-aware downstream gating.
 *
 * This file is the contract: each concrete agent (services/classifier.ts,
 * services/tax-reasoning.ts, …) provides a `StructuredAgentSpec<T>` and
 * calls `runStructuredAgent(spec, input)`. The runner handles retries,
 * latency, model selection, and the user-visible "I tried N times" trail.
 *
 * Why a hand-rolled runner instead of Zod + LangChain + …: declario's brain
 * runs against rs.ge, rs.ge errors are unforgiving, and we need full
 * control of every retry, every prompt rewrite, every confidence
 * downgrade. The complete code path here is ~200 lines and has zero
 * external dependencies beyond Gemini.
 */

export interface StructuredAgentSpec<TOutput> {
  /** Unique stable key for logging + telemetry (e.g. "accounting-classifier-v1"). */
  readonly key: string;
  /**
   * Long rules-heavy system prompt. Should explicitly say:
   *   - "Return one valid JSON object. NO markdown, NO commentary."
   *   - "If you are uncertain, lower `confidence` and explain in `warnings`."
   *   - "Never invent legal facts you cannot ground in the provided context."
   */
  readonly systemPrompt: string;
  /**
   * Gemini responseSchema (JSON-Schema subset). Optional but strongly
   * recommended — when present the model is forced to produce structurally
   * valid output, dramatically reducing retries.
   */
  readonly responseSchema?: Record<string, unknown>;
  /**
   * Runtime validator. MUST throw a descriptive error on invalid output.
   * Returns the validated, typed value on success.
   */
  validate(raw: unknown): TOutput;
  /** Temperature. Default 0.1 — mostly deterministic with small wiggle room. */
  readonly temperature?: number;
  /** Max tokens. Default 2048 (classifier-sized; raise for long reasoning). */
  readonly maxOutputTokens?: number;
  /** Max retries when validation fails. Default 1 (so 2 total attempts). */
  readonly maxRetries?: number;
}

export interface StructuredAgentInput {
  /**
   * The actual data the agent classifies / reasons about. Will be inserted
   * into the prompt under "INPUT:" as pretty-printed JSON.
   */
  payload: unknown;
  /**
   * Optional RAG chunks. Each chunk is injected under "REFERENCE:" with its
   * citation index so the prompt can instruct the agent to cite via `[n.k]`.
   */
  ragChunks?: Array<{
    content: string;
    bookTitle?: string;
    chunkIndex?: number;
  }>;
  /** Optional turn history (for conversational use of an otherwise stateless agent). */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface StructuredAgentResult<TOutput> {
  output: TOutput;
  /**
   * Self-reported confidence (clamped 0..1). Used by the Approval Gate
   * (services/approval-gate.ts) to decide whether to block or auto-submit.
   */
  confidence: number;
  /** Warnings the agent surfaced. Plumbed into the approval gate. */
  warnings: string[];
  /** Gemini model id (full version, not just chat-model name). */
  model: string;
  /** Raw text the model returned on the final successful attempt. For audit. */
  rawText: string;
  /** Number of attempts before validation succeeded. */
  attempts: number;
  /** End-to-end latency in milliseconds. */
  latencyMs: number;
}

interface RunOptions {
  /** Optional Gemini service override (tests inject a fake). */
  gemini?: GeminiService;
}

/**
 * Run a structured agent.
 *
 * Flow:
 *   1. Compose `systemPrompt` + (history) + (RAG chunks) + INPUT payload.
 *   2. Call Gemini in JSON mode.
 *   3. Try `JSON.parse` (with markdown-fence stripping for safety).
 *   4. Run `spec.validate`.
 *   5. On any failure, retry up to `maxRetries` with an appended "your
 *      previous output was invalid because X — try again, output ONE valid
 *      JSON object only" coercion turn.
 *   6. On all retries failing, throw with the last error + last raw text.
 *
 * Errors are intentionally thrown rather than returned as a result — every
 * caller wraps this in a try/catch and emits structured telemetry. This is
 * the same shape used by services/playbook.ts for playbook extraction.
 */
export async function runStructuredAgent<TOutput>(
  spec: StructuredAgentSpec<TOutput>,
  input: StructuredAgentInput,
  opts: RunOptions = {},
): Promise<StructuredAgentResult<TOutput>> {
  const gemini = opts.gemini ?? geminiService;
  const maxRetries = spec.maxRetries ?? 1;
  const totalAttempts = maxRetries + 1;
  const startedAt = Date.now();

  let lastRawText = "";
  let lastError: Error | null = null;
  let coercionHint = "";
  let model = "";

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const userText = composeUserText(input, coercionHint);

    let response: { text: string; model: string };
    try {
      response = await gemini.generateStructured({
        systemPrompt: spec.systemPrompt,
        userText,
        responseSchema: spec.responseSchema,
        temperature: spec.temperature ?? 0.1,
        maxOutputTokens: spec.maxOutputTokens ?? 2048,
      });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Transport-level failures (network, quota) are not parser problems —
      // don't retry with a coercion hint; just retry the call.
      coercionHint = "";
      continue;
    }

    lastRawText = response.text;
    model = response.model;

    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFences(response.text));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      coercionHint = `Your previous response was not valid JSON (${lastError.message}). Output ONE valid JSON object only, no prose, no markdown fences.`;
      continue;
    }

    try {
      const output = spec.validate(parsed);
      const { confidence, warnings } = extractMeta(parsed);
      return {
        output,
        confidence,
        warnings,
        model,
        rawText: response.text,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      coercionHint = `Your previous response did not match the required schema (${lastError.message}). Output ONE valid JSON object only that matches the schema exactly.`;
    }
  }

  throw new StructuredAgentError(spec.key, lastError, lastRawText, totalAttempts);
}

/**
 * Build the user-message text the model sees. Order matters:
 *   1. (optional) prior conversation history
 *   2. RAG reference chunks, numbered for citation
 *   3. The current INPUT payload as pretty JSON
 *   4. (optional) coercion hint when this is a retry attempt
 */
function composeUserText(input: StructuredAgentInput, coercionHint: string): string {
  const parts: string[] = [];

  if (input.history && input.history.length > 0) {
    parts.push("HISTORY:");
    for (const turn of input.history) {
      parts.push(`${turn.role.toUpperCase()}: ${turn.content}`);
    }
    parts.push("");
  }

  if (input.ragChunks && input.ragChunks.length > 0) {
    parts.push("REFERENCE:");
    input.ragChunks.forEach((chunk, i) => {
      const title = chunk.bookTitle ?? "knowledge";
      const idx = chunk.chunkIndex ?? 0;
      parts.push(`[${i + 1}.${idx}] (${title})`);
      parts.push(chunk.content);
      parts.push("");
    });
  }

  parts.push("INPUT:");
  parts.push("```json");
  parts.push(JSON.stringify(input.payload, null, 2));
  parts.push("```");

  if (coercionHint) {
    parts.push("");
    parts.push(coercionHint);
  }

  return parts.join("\n");
}

function stripJsonFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();
}

/**
 * Best-effort extraction of `confidence` and `warnings` from any structured
 * agent output, regardless of the agent's specific schema. The Approval Gate
 * reads these without caring which agent produced them.
 */
function extractMeta(parsed: unknown): { confidence: number; warnings: string[] } {
  const obj = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const rawConfidence = Number(obj.confidence);
  const confidence = Number.isFinite(rawConfidence)
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0.5;
  const rawWarnings = obj.warnings;
  const warnings = Array.isArray(rawWarnings)
    ? rawWarnings.map((w) => String(w)).filter(Boolean)
    : [];
  return { confidence, warnings };
}

export class StructuredAgentError extends Error {
  readonly key: string;
  readonly attempts: number;
  readonly lastRawText: string;
  readonly cause?: Error | null;
  constructor(key: string, cause: Error | null, lastRawText: string, attempts: number) {
    super(
      `Structured agent "${key}" failed after ${attempts} attempt(s): ${
        cause?.message ?? "unknown error"
      }`,
    );
    this.name = "StructuredAgentError";
    this.key = key;
    this.attempts = attempts;
    this.lastRawText = lastRawText;
    this.cause = cause;
  }
}

// ── Validator helpers reused across concrete agent specs ──────────────────

export function expectObject(raw: unknown, where: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${where}: expected an object, got ${typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

export function expectString(raw: unknown, where: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${where}: expected string, got ${typeof raw}`);
  }
  return raw;
}

export function expectNumber(raw: unknown, where: string): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${where}: expected finite number, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export function expectBoolean(raw: unknown, where: string): boolean {
  if (typeof raw !== "boolean") {
    throw new Error(`${where}: expected boolean, got ${typeof raw}`);
  }
  return raw;
}

export function expectStringArray(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${where}: expected array, got ${typeof raw}`);
  }
  return raw.map((v, i) => expectString(v, `${where}[${i}]`));
}

export function expectEnum<T extends string>(
  raw: unknown,
  values: readonly T[],
  where: string,
): T {
  const s = expectString(raw, where);
  if (!(values as readonly string[]).includes(s)) {
    throw new Error(`${where}: expected one of ${values.join("|")}, got "${s}"`);
  }
  return s as T;
}
