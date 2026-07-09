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
  begin_date?: string;
  items: WaybillItemFields[];
  warnings: string[];
}

const EXTRACTION_PROMPT = [
  "You are reading a photo or scan of a Georgian waybill / delivery document (ზედნადები / სასაქონლო ზеднадები).",
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
  let lastError: unknown;
  let text = "";

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await getVertexClient().models.generateContent({
        model: config.geminiChatModel,
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
      text = response.text?.trim() ?? "";
      if (text) break;
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  if (!text) {
    throw lastError ?? new Error("Vision model returned an empty response");
  }

  let parsed: Record<string, unknown>;
  try {
    const cleaned = stripFences(text);
    const obj = JSON.parse(cleaned);
    parsed = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  } catch {
    return {
      is_waybill: false,
      confidence: 0,
      items: [],
      warnings: [
        "ფოტოდან მონაცემების ამოღება ვერ მოხერხდა — სცადეთ უფრო მკაფიო/სწორი სურათი.",
      ],
    };
  }

  return normalizeExtraction(parsed);
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
    '{ "changed": boolean, "waybill": { "is_waybill": boolean, "confidence": number, "waybill_type": number|null, "waybill_type_label": string|null, "seller_name": string|null, "seller_tin": string|null, "buyer_name": string|null, "buyer_tin": string|null, "start_address": string|null, "end_address": string|null, "driver_name": string|null, "driver_tin": string|null, "car_number": string|null, "document_number": string|null, "begin_date": string|null, "items": [{"w_name": string, "unit_txt": string|null, "quantity": number, "price": number}], "warnings": string[] } }',
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
  try {
    const obj = JSON.parse(stripFences(text));
    parsed = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  } catch {
    return { changed: false, extraction: current };
  }

  if (parsed.changed !== true || !parsed.waybill || typeof parsed.waybill !== "object") {
    return { changed: false, extraction: current };
  }
  return {
    changed: true,
    extraction: normalizeExtraction(parsed.waybill as Record<string, unknown>),
  };
}
