/**
 * waybill-vision.ts — extract structured waybill (ზედნადები) fields from a
 * photo using Gemini vision.
 *
 * Same model + transport the codebase already uses for audio (see stt.ts):
 * the image is sent as an `inlineData` base64 part alongside a strict-JSON
 * instruction. We DON'T go through geminiService.generateStructured (it is
 * text-only) — vision needs the inlineData part, so we call the Vertex client
 * directly here, mirroring transcribeAudio().
 *
 * The extraction is intentionally best-effort: it feeds a preview the user
 * MUST confirm before anything is sent to rs.ge, so a wrong field is caught
 * by a human, not filed blindly. `confidence` + `warnings` surface doubt.
 */
import { config } from "../config";
import { HttpError } from "../errors";
import { getVertexClient } from "./vertex";

export interface WaybillItemFields {
  w_name: string;
  unit_txt?: string;
  quantity: number;
  price: number;
}

export interface WaybillExtraction {
  is_waybill: boolean;
  confidence: number; // 0..1, model self-reported
  waybill_type?: number;
  waybill_type_label?: string;
  seller_name?: string;
  seller_tin?: string;
  buyer_name?: string;
  buyer_tin?: string;
  start_address?: string;
  end_address?: string;
  driver_name?: string;
  driver_tin?: string;
  car_number?: string;
  document_number?: string;
  waybill_number?: string;
  sub_waybill_numbers?: string[];
  begin_date?: string;
  items: WaybillItemFields[];
  warnings: string[];
}

const EXTRACTION_PROMPT = [
  "You are reading a photo or scan of a waybill / delivery / goods shipment document.",
  "The document is usually Georgian (ზედნადები / სასაქონლო ზედნადები), but it may also be an English test document labelled WAYBILL or DELIVERY DOCUMENT.",
  "Extract the shipment data and return it as a SINGLE JSON object. NO markdown, NO prose before or after.",
  "",
  "Return exactly this shape (omit a field or use null if it is not visible):",
  "{",
  '  "is_waybill": boolean,            // false if the image is clearly NOT a waybill/delivery/goods document',
  '  "confidence": number,            // 0..1, your confidence the extraction is correct',
  '  "waybill_type": number|null,      // 1=შიდა გადაზიდვა, 2=ტრანსპორტირება, 3=ტრანსპორტირების გარეშე, 4=დისტრიბუცია, 5=უკან დაბრუნება, 6=ქვე-ზედნადები',
  '  "waybill_type_label": string|null,// exact visible/understood type label, if present',
  '  "seller_name": string|null,      // გამყიდველი / მომწოდებელი',
  '  "seller_tin": string|null,       // seller identification number (ს/კ, 9 or 11 digits)',
  '  "buyer_name": string|null,       // მყიდველი / მიმღები',
  '  "buyer_tin": string|null,        // buyer identification number (ს/კ, 9 or 11 digits)',
  '  "start_address": string|null,    // ტვირთის გაგზავნის მისამართი (from)',
  '  "end_address": string|null,      // ტვირთის ჩაბარების მისამართი (to)',
  '  "driver_name": string|null,      // მძღოლი',
  '  "driver_tin": string|null,       // driver identification number',
  '  "car_number": string|null,       // ავტომობილის ნომერი',
  '  "document_number": string|null,  // ზედნადების ნომერი, if already printed on the doc',
  '  "waybill_number": string|null,   // source/original/parent waybill number required for return waybills, if visible',
  '  "sub_waybill_numbers": string[], // linked waybill numbers for sub-waybills, if visible',
  '  "begin_date": string|null,       // shipment date as ISO YYYY-MM-DD if visible',
  '  "items": [                       // line items / goods rows',
  '    { "w_name": string, "unit_txt": string|null, "quantity": number, "price": number }',
  "  ],",
  '  "warnings": string[]             // anything illegible, ambiguous, or that the user should double-check',
  "}",
  "",
  "Rules:",
  "- quantity and price MUST be plain numbers (no currency symbols, no thousands separators).",
  "- price is the UNIT price per item, not the line total. If only a line total is shown, divide by quantity.",
  "- Keep names and addresses in their original language (usually Georgian).",
  "- If the document type is visible, set waybill_type. If unclear, leave it null and add a Georgian warning asking the user to choose the type.",
  "- If the document is not a waybill/goods document, set is_waybill=false and items=[].",
  "- If a number is unreadable, leave the field null and add a Georgian note to warnings.",
].join("\n");

function stripFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

// Close an object/array that the model cut off before its final `}`/`]`.
// Gemini intermittently truncates the JSON tail; the data is all there, so we
// balance the open brackets rather than discard the whole extraction.
function repairTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  if (!inString && stack.length === 0) return null; // already balanced
  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = stripFences(text);
  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }
  if (firstBrace >= 0) {
    const repaired = repairTruncatedJson(cleaned.slice(firstBrace));
    if (repaired) candidates.push(repaired);
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,-]/g, "").replace(/,/g, ".");
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function toStringOrUndefined(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s ? s : undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\n;|]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeItems(raw: unknown): WaybillItemFields[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): WaybillItemFields | null => {
      if (!entry || typeof entry !== "object") return null;
      const o = entry as Record<string, unknown>;
      const name = toStringOrUndefined(o.w_name ?? o.name);
      if (!name) return null;
      return {
        w_name: name,
        unit_txt: toStringOrUndefined(o.unit_txt ?? o.unit),
        quantity: toNumber(o.quantity),
        price: toNumber(o.price),
      };
    })
    .filter((item): item is WaybillItemFields => item !== null);
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /429|500|502|503|504|high demand|unavailable|resource exhausted/i.test(
    message,
  );
}

function retryDelayMs(attempt: number): number {
  return Math.min(600 * 2 ** attempt, 5000);
}

function modelUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /403|404|permission[_\s-]?denied|denied access|not found|not supported|unsupported|model.*(disabled|unavailable)/i.test(
    message,
  );
}

function upstreamMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } };
    return [parsed.error?.status, parsed.error?.message].filter(Boolean).join(": ") || raw;
  } catch {
    return raw;
  }
}

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

export function waybillVisionModelCandidates(): string[] {
  return uniqueModels([
    config.geminiVisionModel,
    ...config.geminiVisionFallbackModels,
    config.geminiChatModel,
  ]);
}

/** Turn a parsed JSON blob (from extraction OR a correction) into a clean WaybillExtraction. */
function normalizeExtraction(parsed: Record<string, unknown>): WaybillExtraction {
  const items = normalizeItems(parsed.items);
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map((w) => String(w)).filter(Boolean)
    : [];
  const confidence = Math.max(0, Math.min(1, toNumber(parsed.confidence)));
  return {
    is_waybill: parsed.is_waybill !== false && items.length > 0,
    confidence,
    waybill_type:
      Number.isInteger(Number(parsed.waybill_type)) && Number(parsed.waybill_type) >= 1 && Number(parsed.waybill_type) <= 6
        ? Number(parsed.waybill_type)
        : undefined,
    waybill_type_label: toStringOrUndefined(parsed.waybill_type_label),
    seller_name: toStringOrUndefined(parsed.seller_name),
    seller_tin: toStringOrUndefined(parsed.seller_tin),
    buyer_name: toStringOrUndefined(parsed.buyer_name),
    buyer_tin: toStringOrUndefined(parsed.buyer_tin),
    start_address: toStringOrUndefined(parsed.start_address),
    end_address: toStringOrUndefined(parsed.end_address),
    driver_name: toStringOrUndefined(parsed.driver_name),
    driver_tin: toStringOrUndefined(parsed.driver_tin),
    car_number: toStringOrUndefined(parsed.car_number),
    document_number: toStringOrUndefined(parsed.document_number),
    waybill_number: toStringOrUndefined(parsed.waybill_number),
    sub_waybill_numbers: toStringArray(parsed.sub_waybill_numbers),
    begin_date: toStringOrUndefined(parsed.begin_date),
    items,
    warnings,
  };
}

/**
 * Run the vision extraction. Returns a normalized WaybillExtraction even when
 * the model returns partial data; throws only when the model call itself fails
 * after a retry or returns no text at all.
 */
export async function extractWaybillFromImage(
  imageBase64: string,
  mimeType: string,
): Promise<WaybillExtraction> {
  const mime = /^image\//.test(mimeType) ? mimeType : "image/jpeg";
  const models = waybillVisionModelCandidates();
  const maxAttempts = Math.max(1, Math.min(8, Math.floor(config.geminiVisionMaxAttempts)));
  let lastError: unknown;
  let text = "";
  let usedModel = "";

  for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
    const model = models[modelIndex];
    const isLastModel = modelIndex === models.length - 1;
    usedModel = model;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await getVertexClient().models.generateContent({
          model,
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: mime, data: imageBase64 } },
                { text: EXTRACTION_PROMPT },
              ],
            },
          ],
          config: {
            temperature: 0,
            maxOutputTokens: 4096,
            responseMimeType: "application/json",
          },
        });
        const raw = response.text?.trim() ?? "";
        if (raw) {
          text = raw;
          const obj = parseJsonObject(raw);
          if (obj) return normalizeExtraction(obj);
          // Non-empty but unparseable — the model truncated the JSON beyond what
          // repairTruncatedJson can salvage. A fresh generation almost always
          // comes back clean, so retry instead of discarding a valid upload.
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
            continue;
          }
        }
      } catch (error) {
        lastError = error;
        if (modelUnavailable(error)) break;
        if (retryable(error) && attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
          continue;
        }
        if (retryable(error) && !isLastModel) break;
        if (!retryable(error) || isLastModel) {
          throw new HttpError(502, `Gemini vision failed: ${upstreamMessage(error)}`);
        }
      }
    }
  }

  if (!text) {
    throw new HttpError(
      502,
      `Gemini vision failed for configured model(s) (${models.join(", ") || usedModel}): ${upstreamMessage(lastError ?? "empty response")}`,
    );
  }

  // Non-empty responses that never parsed across every model+attempt — tell the
  // user to retry with a clearer photo rather than crashing.
  return {
    is_waybill: false,
    confidence: 0,
    items: [],
    warnings: [
      "ფოტოდან მონაცემების ამოღება ვერ მოხერხდა — სცადეთ უფრო მკაფიო/სწორი სურათი.",
    ],
  };
}

/**
 * Apply a free-text user correction to an already-extracted waybill that is
 * awaiting confirmation. Returns `changed:false` (and the data unchanged) when
 * the message isn't actually about editing the waybill, so the caller can fall
 * back to normal chat. Text-only model call (no image).
 */
export async function applyWaybillCorrection(
  current: WaybillExtraction,
  instruction: string,
): Promise<{ changed: boolean; extraction: WaybillExtraction }> {
  const prompt = [
    "You maintain the extracted data of a Georgian waybill (ზеднадеби) that is awaiting the user's confirmation before being sent to rs.ge.",
    "Below is the CURRENT data as JSON, then a message from the user.",
    "If the user's message corrects or changes one or more fields (buyer name/TIN, addresses, driver name/TIN, car number, or any line item's name/unit/quantity/price, including adding or removing items), apply ALL the changes and return the FULL updated object with changed=true.",
    "If the user's message is NOT about changing this waybill (a question, chit-chat, or unrelated request), return the data UNCHANGED with changed=false.",
    "",
    "Return JSON ONLY in this shape (no markdown):",
    '{ "changed": boolean, "waybill": { "is_waybill": boolean, "confidence": number, "waybill_type": number|null, "waybill_type_label": string|null, "seller_name": string|null, "seller_tin": string|null, "buyer_name": string|null, "buyer_tin": string|null, "start_address": string|null, "end_address": string|null, "driver_name": string|null, "driver_tin": string|null, "car_number": string|null, "document_number": string|null, "waybill_number": string|null, "sub_waybill_numbers": string[], "begin_date": string|null, "items": [{"w_name": string, "unit_txt": string|null, "quantity": number, "price": number}], "warnings": string[] } }',
    "Rules: quantity and price are plain numbers; price is per-unit. Keep Georgian text as-is. Preserve every field the user did NOT mention.",
    "",
    "CURRENT DATA:",
    JSON.stringify(current),
    "",
    "USER MESSAGE:",
    instruction,
  ].join("\n");

  let text = "";
  try {
    const response = await getVertexClient().models.generateContent({
      model: config.geminiChatModel,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0,
        maxOutputTokens: 4096,
        responseMimeType: "application/json",
      },
    });
    text = response.text?.trim() ?? "";
  } catch {
    return { changed: false, extraction: current };
  }
  if (!text) return { changed: false, extraction: current };

  let parsed: Record<string, unknown>;
  const obj = parseJsonObject(text);
  if (!obj) {
    return { changed: false, extraction: current };
  }
  parsed = obj;

  if (parsed.changed !== true || !parsed.waybill || typeof parsed.waybill !== "object") {
    return { changed: false, extraction: current };
  }
  return {
    changed: true,
    extraction: normalizeExtraction(parsed.waybill as Record<string, unknown>),
  };
}
