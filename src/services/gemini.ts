import {
  GoogleGenAI,
  Content,
  FunctionCall,
  FunctionDeclaration,
} from "@google/genai";
import { config } from "../config";
import { HttpError } from "../errors";

export interface ValidationIssue {
  field: string;
  value: string;
  level: "ok" | "info" | "warn" | "error";
  reason: string;
}

/**
 * Result of a single `generateWithTools` round-trip.
 *
 * Either `functionCalls` is non-empty (model wants to call tools — caller
 * dispatches and re-prompts with the results) or `text` is non-empty
 * (model produced a final answer). The two are mutually exclusive in
 * practice, but we surface both because Gemini occasionally returns
 * stale-by-construction text alongside a tool call.
 */
export interface ToolCallTurn {
  functionCalls: FunctionCall[];
  text: string;
  model: string;
  /**
   * The model's raw turn content (parts), echoed back verbatim on the next
   * call. Critical for "thinking" Gemini models: each functionCall part
   * carries a `thoughtSignature` that MUST be preserved, otherwise the next
   * request fails with "Function call is missing a thought_signature".
   */
  modelContent?: Content;
}

export interface GeminiService {
  embed(text: string): Promise<number[]>;
  generateChatResponse(messages: Content[]): Promise<{ text: string; model: string }>;
  /**
   * Strict JSON-mode call. The model is constrained to output a single JSON
   * object/array; we still return raw text because Gemini's JSON-mode is
   * best-effort and the caller must validate. Used by every structured
   * agent in `services/structured-agent.ts`.
   */
  generateStructured(input: {
    systemPrompt: string;
    userText: string;
    responseSchema?: Record<string, unknown>;
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<{ text: string; model: string }>;
  /**
   * Tool-calling round-trip. Pass the conversation `contents` plus a
   * function-declaration tool catalog; the model either calls one or more
   * functions (returned in `functionCalls`) or produces a final text
   * answer (`text`). The caller is responsible for the loop: dispatch the
   * calls, append both the model's functionCall parts and the tool
   * responses to `contents`, then call again until `functionCalls` is
   * empty.
   *
   * `toolChoice` mirrors Gemini's three modes: "auto" lets the model
   * decide (default), "any" forces a tool call, "none" forbids them
   * (useful to coerce a final summary after an iteration cap).
   */
  generateWithTools(input: {
    systemInstruction?: string;
    contents: Content[];
    tools: FunctionDeclaration[];
    toolChoice?: "auto" | "any" | "none";
    temperature?: number;
    maxOutputTokens?: number;
  }): Promise<ToolCallTurn>;
  /**
   * Validate user-supplied row data against accounting-knowledge chunks.
   * Returns one issue per non-trivial field that the tax code calls out.
   */
  validateData(
    data: Record<string, string>,
    chunks: Array<{ content: string; book_title?: string }>,
    options?: { taskHint?: string },
  ): Promise<ValidationIssue[]>;
}

let aiClient: GoogleGenAI | null = null;

function validationWarning(reason: string): ValidationIssue[] {
  return [{
    field: "validation",
    value: "",
    level: "warn",
    reason,
  }];
}

function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new HttpError(503, "GEMINI_API_KEY is required to call Gemini");
  }

  if (!aiClient) {
    aiClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  return aiClient;
}

export const geminiService: GeminiService = {
  async embed(text: string): Promise<number[]> {
    const response = await getClient().models.embedContent({
      model: config.geminiEmbeddingModel,
      contents: text,
      config: {
        outputDimensionality: config.geminiEmbeddingDimensions,
      },
    });

    const values = response.embeddings?.[0]?.values;

    if (!values?.length) {
      throw new Error("Gemini embedding response did not include values");
    }

    return values;
  },

  async generateChatResponse(messages: Content[]): Promise<{ text: string; model: string }> {
    const response = await getClient().models.generateContent({
      model: config.geminiChatModel,
      contents: messages,
      config: {
        maxOutputTokens: config.geminiChatMaxOutputTokens,
        temperature: config.geminiChatTemperature,
      },
    });

    const text = response.text?.trim();

    if (!text) {
      throw new Error("Gemini chat response did not include text");
    }

    return {
      text,
      model: response.modelVersion ?? config.geminiChatModel,
    };
  },

  async generateWithTools(input): Promise<ToolCallTurn> {
    const mode =
      input.toolChoice === "any"
        ? "ANY"
        : input.toolChoice === "none"
          ? "NONE"
          : "AUTO";
    const response = await getClient().models.generateContent({
      model: config.geminiChatModel,
      contents: input.contents,
      config: {
        maxOutputTokens: input.maxOutputTokens ?? config.geminiChatMaxOutputTokens,
        temperature: input.temperature ?? config.geminiChatTemperature,
        ...(input.systemInstruction
          ? { systemInstruction: input.systemInstruction }
          : {}),
        // Gemini takes the tool catalog at the top level of `tools` and the
        // mode in `toolConfig.functionCallingConfig.mode`.
        tools: [{ functionDeclarations: input.tools }],
        toolConfig: {
          functionCallingConfig: { mode: mode as never },
        },
      },
    });

    const functionCalls = response.functionCalls ?? [];
    return {
      functionCalls,
      text: response.text?.trim() ?? "",
      model: response.modelVersion ?? config.geminiChatModel,
      modelContent: response.candidates?.[0]?.content,
    };
  },

  async generateStructured(input): Promise<{ text: string; model: string }> {
    const response = await getClient().models.generateContent({
      model: config.geminiChatModel,
      contents: [
        // System instruction baked into the user turn — same approach as
        // validateData() to keep things consistent across the codebase.
        { role: "user", parts: [{ text: input.systemPrompt }] },
        { role: "user", parts: [{ text: input.userText }] },
      ],
      config: {
        maxOutputTokens: input.maxOutputTokens ?? 4096,
        temperature: input.temperature ?? 0.1,
        responseMimeType: "application/json",
        ...(input.responseSchema
          ? { responseSchema: input.responseSchema as never }
          : {}),
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error("Gemini structured response did not include text");
    }
    return {
      text,
      model: response.modelVersion ?? config.geminiChatModel,
    };
  },

  async validateData(data, chunks, options = {}): Promise<ValidationIssue[]> {
    // Filter out fields the tax code wouldn't comment on (creds + meta + zeros).
    const skipKey = /password|token|otp|secret|pin|^username$|^user$|email|login|^period$|^company(_name)?$|^notes$/i;
    const checkable = Object.entries(data).filter(([k, v]) => {
      if (skipKey.test(k)) return false;
      const s = String(v ?? "").trim();
      if (!s) return false;
      if (s === "0" || s === "0.0" || s === "0.00") return false;
      if (s === "[]" || s === "{}") return false;
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

    const dataLines = checkable
      .map(([k, v]) => `- "${k}" = ${JSON.stringify(String(v))}`)
      .join("\n");

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
      "- Each element: {\"field\": <key>, \"value\": <value as string>, \"level\": \"ok\"|\"info\"|\"warn\"|\"error\", \"reason\": <one sentence in Georgian or English>}.",
      "- Only include fields that are NOT \"ok\" — i.e. only return issues. If everything looks fine, return [].",
      "- 'error' = the code says this section is forbidden / mutually exclusive / requires a license user doesn't have.",
      "- 'warn' = unusual for a typical small business; user should verify.",
      "- 'info' = noteworthy but not blocking.",
      "- Do NOT invent fields not in the data. Use the exact key string.",
    ].join("\n");

    let response;
    try {
      response = await getClient().models.generateContent({
        model: config.geminiChatModel,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: {
          maxOutputTokens: 4096,
          temperature: 0,
          responseMimeType: "application/json",
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn("[validateData] Gemini validation failed:", reason);
      return validationWarning(`Knowledge validation is unknown because Gemini validation failed: ${reason}`);
    }

    const text = response.text?.trim() ?? "";
    if (!text) return validationWarning("Knowledge validation is unknown because Gemini returned an empty response.");

    let parsed: unknown;
    try {
      // Strip ```json ... ``` fences if the model snuck them in.
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      console.warn("[validateData] could not parse Gemini JSON:", text.slice(0, 300));
      return validationWarning("Knowledge validation is unknown because Gemini returned invalid JSON.");
    }
    if (!Array.isArray(parsed)) {
      return validationWarning("Knowledge validation is unknown because Gemini returned a non-array response.");
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
      // Only echo issues whose field actually exists in the supplied data.
      if (!known.has(field)) continue;
      if (level === "ok") continue;
      issues.push({ field, value, level: level as ValidationIssue["level"], reason });
    }
    return issues;
  },
};

