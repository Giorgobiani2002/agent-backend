/**
 * gemini.ts - Vertex AI Gemini backend via @google/genai
 *
 * Uses the shared Vertex AI / Gemini Enterprise client from vertex.ts.
 * Models: gemini-3.5-flash (chat) + gemini-embedding-2 @1536 (embeddings).
 */
import {
  Content,
  FunctionCall,
  FunctionDeclaration,
} from "@google/genai";
import { config } from "../config";
import { getVertexClient, resetVertexClient } from "./vertex";

export interface ValidationIssue {
  field: string;
  value: string;
  level: "ok" | "info" | "warn" | "error";
  reason: string;
}

export interface ToolCallTurn {
  functionCalls: FunctionCall[];
  text: string;
  model: string;
  modelContent?: Content;
}

export interface GeminiService {
  embed(text: string): Promise<number[]>;
  generateChatResponse(messages: Content[]): Promise<{ text: string; model: string }>;
  generateStructured(input: {
    systemPrompt: string;
    userText: string;
    responseSchema?: Record<string, unknown>;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<{ text: string; model: string }>;
  generateWithTools(input: {
    systemInstruction?: string;
    contents: Content[];
    tools: FunctionDeclaration[];
    toolChoice?: "auto" | "any" | "none";
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<ToolCallTurn>;
  validateData(
    data: Record<string, string>,
    chunks: Array<{ content: string; book_title?: string }>,
    options?: { taskHint?: string },
  ): Promise<ValidationIssue[]>;
}

/** Call this when you want to force-recreate the client (e.g. during hot-reload). */
export function resetClient() {
  resetVertexClient();
}

function validationWarning(reason: string): ValidationIssue[] {
  return [{ field: "validation", value: "", level: "warn", reason }];
}

// Gemini intermittently returns 503 "high demand" / UNAVAILABLE during spikes.
// Without a retry a single spike hard-fails the whole chat turn (→ 502 to the
// user). Retry transient errors a few times with exponential backoff + jitter.
const TRANSIENT_LLM_RE =
  /\b(429|500|502|503|504)\b|high demand|overloaded|unavailable|resource exhausted/i;

function isTransientLlmError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_LLM_RE.test(message);
}

async function withLlmRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientLlmError(error) || attempt === attempts - 1) throw error;
      const backoffMs = 400 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastError;
}

// ── Implement GeminiService interface ─────────────────────────────────────────
function uniqueModels(models: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const trimmed = model?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function geminiChatModelCandidates(): string[] {
  return uniqueModels([
    config.geminiChatModel,
    ...config.geminiChatFallbackModels,
  ]);
}

async function withLlmFallback<T>(
  fn: (model: string) => Promise<T>,
  attempts = 3,
): Promise<{ response: T; model: string }> {
  const models = geminiChatModelCandidates();
  let lastError: unknown;

  for (const model of models) {
    try {
      return {
        response: await withLlmRetry(() => fn(model), attempts),
        model,
      };
    } catch (error) {
      lastError = error;
      if (!isTransientLlmError(error)) throw error;
    }
  }

  throw lastError;
}

export const geminiService: GeminiService = {
  // ── Embeddings ──
  async embed(text: string): Promise<number[]> {
    const response = await getVertexClient().models.embedContent({
      model: config.geminiEmbeddingModel,
      contents: text,
      config: {
        outputDimensionality: config.geminiEmbeddingDimensions,
      },
    });
    const values = response.embeddings?.[0]?.values;
    if (!values?.length) throw new Error("Vertex AI embedding returned no values");
    return values;
  },

  // ── Chat ──
  async generateChatResponse(messages: Content[]): Promise<{ text: string; model: string }> {
    const { response, model } = await withLlmFallback((model) =>
      getVertexClient().models.generateContent({
        model,
        contents: messages,
        config: {
          maxOutputTokens: config.geminiChatMaxOutputTokens,
          temperature: config.geminiChatTemperature,
        },
      }),
    );
    const text = response.text?.trim();
    if (!text) throw new Error("Vertex AI chat response returned empty text");
    return { text, model: response.modelVersion ?? model };
  },

  // ── Tool-calling ──
  async generateWithTools(input): Promise<ToolCallTurn> {
    const modeMap: Record<string, string> = { any: "ANY", none: "NONE", auto: "AUTO" };
    const mode = modeMap[input.toolChoice ?? "auto"] ?? "AUTO";

    const { response, model } = await withLlmFallback((model) =>
      getVertexClient().models.generateContent({
        model,
        contents: input.contents,
        config: {
          maxOutputTokens: input.maxOutputTokens ?? config.geminiChatMaxOutputTokens,
          temperature: input.temperature ?? config.geminiChatTemperature,
          ...(input.systemInstruction ? { systemInstruction: input.systemInstruction } : {}),
          tools: [{ functionDeclarations: input.tools }],
          toolConfig: { functionCallingConfig: { mode: mode as never } },
        },
      }),
    );

    const functionCalls = response.functionCalls ?? [];
    return {
      functionCalls,
      text: response.text?.trim() ?? "",
      model: response.modelVersion ?? model,
      modelContent: response.candidates?.[0]?.content,
    };
  },

  // ── Structured JSON ──
  async generateStructured(input): Promise<{ text: string; model: string }> {
    const { response, model } = await withLlmFallback((model) =>
      getVertexClient().models.generateContent({
        model,
        contents: [
          { role: "user", parts: [{ text: input.systemPrompt }] },
          { role: "user", parts: [{ text: input.userText }] },
        ],
        config: {
          maxOutputTokens: input.maxOutputTokens ?? 4096,
          temperature: input.temperature ?? 0.1,
          responseMimeType: "application/json",
          ...(input.responseSchema ? { responseSchema: input.responseSchema as never } : {}),
        },
      }),
    );
    const text = response.text?.trim();
    if (!text) throw new Error("Vertex AI structured response returned empty text");
    return { text, model: response.modelVersion ?? model };
  },

  // ── Data validation ──
  async validateData(data, chunks, options = {}): Promise<ValidationIssue[]> {
    const skipKey = /password|token|otp|secret|pin|^username$|^user$|email|login|^period$|^company(_name)?$|^notes$/i;
    const checkable = Object.entries(data).filter(([k, v]) => {
      if (skipKey.test(k)) return false;
      const s = String(v ?? "").trim();
      if (!s || s === "0" || s === "0.0" || s === "0.00" || s === "[]" || s === "{}") return false;
      return true;
    });
    if (checkable.length === 0) return [];
    if (!chunks.length) {
      return validationWarning("Knowledge validation could not run because no matching source chunks were found.");
    }

    const knowledgeBlock = chunks
      .map((c, i) => {
        const head = c.book_title ? `[${i + 1}] ${c.book_title}` : `[${i + 1}]`;
        return `${head}\n${(c.content ?? "").slice(0, 1200)}`;
      })
      .join("\n\n---\n\n")
      .slice(0, 60_000);

    const dataLines = checkable.map(([k, v]) => `- "${k}" = ${JSON.stringify(String(v))}`).join("\n");
    const taskHint = options.taskHint?.trim() || "(none)";

    const prompt = [
      "You are a Georgian tax-code validator for VAT declarations on rs.ge.",
      "Below are excerpts from the user's accounting-knowledge base, followed by a single row of Excel data.",
      "Decide whether each non-zero / non-empty field is appropriate for a typical Georgian taxpayer filing this declaration.",
      "",
      "ACCOUNTING-KNOWLEDGE CHUNKS:",
      knowledgeBlock || "(no chunks found)",
      "",
      `TASK HINT (free-form, optional): ${taskHint}`,
      "",
      "DATA (key = Excel column / form field, value = entered value):",
      dataLines,
      "",
      "OUTPUT REQUIREMENTS:",
      "- Reply with a single JSON array. NO markdown, NO prose before or after.",
      `- Each element: {"field": <key>, "value": <value as string>, "level": "ok"|"info"|"warn"|"error", "reason": <one sentence in Georgian or English>}.`,
      "- Only include fields that are NOT \"ok\" — i.e. only return issues. If everything looks fine, return [].",
    ].join("\n");

    let text = "";
    try {
      const { response } = await withLlmFallback((model) =>
        getVertexClient().models.generateContent({
          model,
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: { maxOutputTokens: 4096, temperature: 0, responseMimeType: "application/json" },
        }),
      );
      text = response.text?.trim() ?? "";
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("[validateData] Vertex AI validation failed:", reason);
      return validationWarning(`Knowledge validation is unknown because Vertex AI validation failed: ${reason}`);
    }

    if (!text) return validationWarning("Knowledge validation is unknown because Vertex AI returned an empty response.");

    let parsed: unknown;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn("[validateData] could not parse Vertex AI JSON:", text.slice(0, 300));
      return validationWarning("Knowledge validation is unknown because Vertex AI returned invalid JSON.");
    }
    if (!Array.isArray(parsed)) {
      return validationWarning("Knowledge validation is unknown because Vertex AI returned a non-array response.");
    }

    const ALLOWED_LEVELS = new Set(["ok", "info", "warn", "error"]);
    const known = new Set(Object.keys(data));
    const issues: ValidationIssue[] = [];
    for (const raw of parsed) {
      if (!raw || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      const field = typeof o.field === "string" ? o.field : "";
      const level = typeof o.level === "string" ? o.level : "";
      const reason = typeof o.reason === "string" ? o.reason : "";
      const value = o.value == null ? "" : String(o.value);
      if (!field || !ALLOWED_LEVELS.has(level) || !reason) continue;
      if (!known.has(field)) continue;
      if (level === "ok") continue;
      issues.push({ field, value, level: level as ValidationIssue["level"], reason });
    }
    return issues;
  },
};
