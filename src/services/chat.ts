import { Content, FunctionCall } from "@google/genai";
import { config } from "../config";
import { HttpError } from "../errors";
import {
  createConversation,
  deleteConversation,
  getConversation,
  getMessages,
  getRecentMessages,
  listConversations,
  persistChatTurn,
} from "../repositories/chat";
import {
  BookChunkRow,
  loadChunksForBooks,
  searchBookChunks,
} from "../repositories/books";
import { formatQueryForEmbedding } from "../utils/chunking";
import { GeminiService, geminiService } from "./gemini";
import {
  chatToolSystemInstruction,
  dispatchTool,
  looksLikeDiagnosticQuery,
  toolDeclarations,
} from "./chat-tools";
import { checkAndBumpChatLimit } from "./chat-rate-limit";
import {
  getChatAttachments,
  getChatAttachmentById,
  getLatestParsedAttachment,
  markChatAttachmentStatus,
  claimImageAttachmentForSend,
  claimAttachmentForSend,
  updateChatAttachmentParsedData,
  type ChatAttachmentRow,
} from "../repositories/chat-attachments";
import { rsServerClient } from "./rs-server-client";
import {
  applyWaybillCorrection,
  type WaybillExtraction,
  type WaybillItemFields,
} from "./waybill-vision";
import {
  isSendableWaybillDraft,
  type WaybillSpreadsheetDraft,
} from "../utils/waybill-spreadsheet";
import { createHash } from "crypto";

interface DocumentContext {
  bookId: string;
  title: string;
  bookMetadata: Record<string, unknown>;
  seedSimilarity?: number;
  chunks: BookChunkRow[];
  totalChunks: number;
  droppedChunks: number;
}

const RAG_CONTEXT_PREVIEW_CHARS = 400;
const VOICE_MAX_OUTPUT_TOKENS = 240;
const DOMAIN_GUARD_MODEL = "declario-domain-guard-v1";
const DOMAIN_GUARD_INSTRUCTION = [
  "Scope policy: declario only helps with finance, accounting, bookkeeping, taxes, payroll, VAT, profit tax, invoices, waybills, bank statements, declarations, rs.ge, business operations data, uploaded financial documents/spreadsheets, and Declario product workflows.",
  "If the user asks about politics, public figures, entertainment, gossip, culture-war/provocative topics, general trivia, medical, legal matters outside tax/accounting, coding, or any other off-topic subject, do not answer the substance. Briefly say you can help with finance/accounting/tax/rs.ge topics and ask them to reframe it in that context.",
  "Do not debate or analyze Georgian politicians or public figures unless the question is directly about a finance, tax, accounting, payroll, compliance, or business-record issue.",
].join(" ");
const VOICE_SYSTEM_INSTRUCTION = [
  "You are in a live voice conversation.",
  "Reply in the same language as the user's latest message.",
  "Sound natural, attentive, and direct, like a helpful person in a real conversation.",
  "Usually answer in one or two short sentences and stay under 45 words unless the user explicitly asks for detail.",
  "Do not repeat the question, give a speech, use headings, bullets, markdown, or citations in a spoken reply.",
  "Ask at most one short follow-up question when information is missing.",
].join(" ");

function clipChunkPreviewForMetadata(content: string, maxChars: number): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function chunkSourceUrl(metadata: Record<string, unknown>): string | undefined {
  if (typeof metadata.sourceUrl === "string" && metadata.sourceUrl.length > 0) {
    return metadata.sourceUrl;
  }
  if (typeof metadata.url === "string" && metadata.url.length > 0) {
    return metadata.url;
  }
  if (typeof metadata.videoId === "string" && metadata.videoId.length > 0) {
    return `https://www.youtube.com/watch?v=${encodeURIComponent(metadata.videoId)}`;
  }
  return undefined;
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

// Greetings, presence checks ("are you there?"), thanks and short
// acknowledgements are conversational — they should get a normal brief reply,
// not a domain refusal. Substantive off-topic questions are still caught (the
// in-scope regex below + the model's own scope instruction handle those).
function isGreetingOrCapabilityQuestion(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  return (
    // Greetings (whole message is just a greeting).
    /^(hi|hello|hey|hiya|yo|გამარჯობა|გამარჯობათ|სალამი|გაუმარჯოს|ჰაი|ჰელ(ო|ოუ)|ჰეი)[\s!.?…]*$/i.test(
      normalized,
    ) ||
    // Presence / "are you there?" (may appear mid-sentence — benign).
    /(აქ\s*ხ(ა|არ)|აქა\s*ხარ|ხარ\s*აქ|მისმენ|გესმი|are you (there|here|around|alive)|you (still )?there|still (there|here)|hello\?|anybody|anyone there)/i.test(
      normalized,
    ) ||
    // Thanks / acknowledgement / sign-off (whole message only, so it can't
    // smuggle an off-topic question through).
    /^(გმადლობ\w*|მადლობ\w*|დიდი მადლობა|გასაგებია|კარგი|კაი|ოკ\w*|okay|ok|thanks|thank you|ty|got it|nice|cool|ნახვამდის|bye)[\s!.?…]*$/i.test(
      normalized,
    ) ||
    // Capability questions.
    /(what can you do|help me|your capabilities|შეგიძლია|რას აკეთებ|რაში დამეხმარები|რა იცი|რა ცოდნა გაქვს)/i.test(
      normalized,
    )
  );
}

function isInScopeChatTopic(text: string): boolean {
  if (isGreetingOrCapabilityQuestion(text)) return true;
  if (looksLikeWaybillCorrection(text)) return true;
  return /(declario|rs\.?ge|revenue service|შემოსავლების|ფინანს|ბუღალტ|account|accounting|bookkeep|finance|financial|tax|vat|დღგ|profit tax|მოგების|გადასახად|declaration|დეკლარაცი|invoice|ფაქტურ|waybill|ზედნადებ|payroll|salary|ხელფას|employee|თანამშრომ|pension|პენსი|bank|ბანკ|statement|ამონაწერ|order|შეკვეთ|shopify|integration|pipeline|bulk|upload|ატვირთ|file|submit|rs-|საგადასახადო|საფინანსო|კომპანი|business|ბიზნეს|cash|revenue|expense|income|cost|ფას|რაოდენ|მისამართ|მყიდველ|asset|აქტივ|ledger|journal|balance|trial balance|excel|spreadsheet|xlsx|csv|დოკუმენტ|document|receipt|ჩეკ|audit|compliance|კომპლაიანს|ზედმეტობა|დავალიან|ვალდებულ)/i.test(
    text,
  );
}

function domainGuardReply(text: string, voiceMode: boolean): string | null {
  if (isInScopeChatTopic(text)) return null;
  if (voiceMode) {
    return "ამ თემაზე ვერ გიპასუხებთ. დამისვით კითხვა ფინანსებზე, ბუღალტერიაზე, გადასახადებზე, rs.ge-ზე ან Declario-ს მონაცემებზე.";
  }
  return [
    "ამ თემაზე ვერ გიპასუხებთ, რადგან Declario-ს ჩატი განკუთვნილია ფინანსების, ბუღალტერიის, გადასახადების, payroll-ის, rs.ge ოპერაციების, დოკუმენტებისა და კომპანიის ბიზნეს-მონაცემების საკითხებისთვის.",
    "",
    "თუ კითხვა ამ კონტექსტს უკავშირდება, მომწერეთ ფინანსური/საგადასახადო ნაწილი და იმაზე დაგეხმარებით.",
  ].join("\n");
}

/**
 * When a transcript/book is larger than the char budget, naive chunk-0-first order drops
 * the very region vector search found (e.g. "upload declaration" at chunk 80). Prefer the
 * seed span ± window first, then earlier context, then later.
 */
function prioritizedChunksForBook(
  chunks: BookChunkRow[],
  seedChunkIndices: number[],
  anchorWindow: number,
): BookChunkRow[] {
  if (!chunks.length) {
    return [];
  }

  const sorted = [...chunks].sort((a, b) => a.chunk_index - b.chunk_index);

  if (!seedChunkIndices.length) {
    return sorted;
  }

  const minSeed = Math.min(...seedChunkIndices);
  const maxSeed = Math.max(...seedChunkIndices);
  const low = minSeed - anchorWindow;
  const high = maxSeed + anchorWindow;

  const center = sorted.filter((c) => c.chunk_index >= low && c.chunk_index <= high);
  const below = sorted
    .filter((c) => c.chunk_index < low)
    .sort((a, b) => b.chunk_index - a.chunk_index);
  const above = sorted.filter((c) => c.chunk_index > high);

  return [...center, ...below, ...above];
}

function getUpstreamErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

interface ComprehensiveContext {
  documents: DocumentContext[];
  contexts: BookChunkRow[];
  selectedBookIds: string[];
  totalDocuments: number;
  totalChunks: number;
  includedChunks: number;
  truncated: boolean;
}

function emptyContext(): ComprehensiveContext {
  return {
    documents: [],
    contexts: [],
    selectedBookIds: [],
    totalDocuments: 0,
    totalChunks: 0,
    includedChunks: 0,
    truncated: false,
  };
}

async function gatherComprehensiveContext(
  embedding: number[],
): Promise<ComprehensiveContext> {
  const seeds = await searchBookChunks(embedding, config.ragTopK);

  if (!seeds.length) {
    return {
      documents: [],
      contexts: [],
      selectedBookIds: [],
      totalDocuments: 0,
      totalChunks: 0,
      includedChunks: 0,
      truncated: false,
    };
  }

  const seenBookIds = new Set<string>();
  const orderedBookIds: string[] = [];
  const seedSimilarityByBookId = new Map<string, number>();

  for (const seed of seeds) {
    if (typeof seed.similarity === "number") {
      const previous = seedSimilarityByBookId.get(seed.book_id);
      if (previous === undefined || seed.similarity > previous) {
        seedSimilarityByBookId.set(seed.book_id, seed.similarity);
      }
    }

    if (
      !seenBookIds.has(seed.book_id) &&
      orderedBookIds.length < config.ragDocumentLimit
    ) {
      seenBookIds.add(seed.book_id);
      orderedBookIds.push(seed.book_id);
    }
  }

  const seedChunkIndicesByBook = new Map<string, number[]>();
  for (const seed of seeds) {
    const list = seedChunkIndicesByBook.get(seed.book_id) ?? [];
    if (!list.includes(seed.chunk_index)) {
      list.push(seed.chunk_index);
    }
    seedChunkIndicesByBook.set(seed.book_id, list);
  }

  const fullChunks = await loadChunksForBooks(orderedBookIds);

  const groups = new Map<string, BookChunkRow[]>();
  for (const chunk of fullChunks) {
    let bucket = groups.get(chunk.book_id);
    if (!bucket) {
      bucket = [];
      groups.set(chunk.book_id, bucket);
    }
    bucket.push(chunk);
  }

  let usedChars = 0;
  let totalChunks = 0;
  let includedChunks = 0;
  let truncated = false;

  const documents: DocumentContext[] = [];
  const contexts: BookChunkRow[] = [];

  for (const bookId of orderedBookIds) {
    const chunks = groups.get(bookId) ?? [];
    totalChunks += chunks.length;

    const seedSimilarity = seedSimilarityByBookId.get(bookId);
    const includedForBook: BookChunkRow[] = [];
    let droppedChunks = 0;

    const seedIndices = seedChunkIndicesByBook.get(bookId) ?? [];
    const prioritized = prioritizedChunksForBook(
      chunks,
      seedIndices,
      config.ragChunkAnchorWindow,
    );

    for (const chunk of prioritized) {
      const len = chunk.char_count > 0 ? chunk.char_count : chunk.content.length;
      if (
        usedChars + len > config.ragMaxContextChars &&
        includedForBook.length > 0
      ) {
        droppedChunks += 1;
        truncated = true;
        continue;
      }
      includedForBook.push(chunk);
      usedChars += len;
      includedChunks += 1;
    }

    if (includedForBook.length === 0 && chunks.length > 0) {
      const seedChunk = chunks[0];
      const len =
        seedChunk.char_count > 0 ? seedChunk.char_count : seedChunk.content.length;
      includedForBook.push(seedChunk);
      usedChars += len;
      includedChunks += 1;
      droppedChunks = chunks.length - 1;
      if (droppedChunks > 0) {
        truncated = true;
      }
    }

    includedForBook.sort((a, b) => a.chunk_index - b.chunk_index);

    const headerChunk = includedForBook[0] ?? chunks[0];

    documents.push({
      bookId,
      title: headerChunk?.book_title ?? "Untitled",
      bookMetadata: asJsonObject(headerChunk?.book_metadata),
      seedSimilarity,
      chunks: includedForBook,
      totalChunks: chunks.length,
      droppedChunks,
    });

    for (const chunk of includedForBook) {
      contexts.push({
        ...chunk,
        similarity: chunk.similarity ?? seedSimilarity ?? 0,
        rank: contexts.length + 1,
      });
    }
  }

  return {
    documents,
    contexts,
    selectedBookIds: orderedBookIds,
    totalDocuments: documents.length,
    totalChunks,
    includedChunks,
    truncated,
  };
}

function describeBookSource(metadata: Record<string, unknown>): string {
  const parts: string[] = [];
  const source = typeof metadata.source === "string" ? metadata.source : undefined;
  const url =
    typeof metadata.sourceUrl === "string"
      ? metadata.sourceUrl
      : typeof metadata.url === "string"
        ? metadata.url
        : undefined;
  const videoId =
    typeof metadata.videoId === "string" ? metadata.videoId : undefined;
  const sourcePath =
    typeof metadata.sourcePath === "string" ? metadata.sourcePath : undefined;

  if (source) parts.push(`source=${source}`);
  if (videoId) parts.push(`videoId=${videoId}`);
  if (url) parts.push(`url=${url}`);
  if (!videoId && !url && sourcePath) parts.push(`sourcePath=${sourcePath}`);
  if (typeof metadata.attribution === "string") {
    parts.push(`attribution=${metadata.attribution}`);
  }
  if (typeof metadata.license === "string") parts.push(`license=${metadata.license}`);
  if (typeof metadata.effectiveFrom === "string") {
    parts.push(`effectiveFrom=${metadata.effectiveFrom}`);
  }
  if (typeof metadata.effectiveTo === "string") {
    parts.push(`effectiveTo=${metadata.effectiveTo}`);
  }

  return parts.join(" ");
}

function buildContextPrompt(context: ComprehensiveContext): string {
  if (!context.documents.length) {
    return "No relevant knowledge base sources were found. Answer from the conversation only.";
  }

  const sections = context.documents.map((doc, index) => {
    const sourceLine = describeBookSource(doc.bookMetadata);
    const headerParts = [
      `Source [${index + 1}] "${doc.title}"`,
      `bookId=${doc.bookId}`,
      sourceLine || undefined,
      typeof doc.seedSimilarity === "number"
        ? `topSimilarity=${doc.seedSimilarity.toFixed(4)}`
        : undefined,
      doc.droppedChunks > 0
        ? `truncated=${doc.droppedChunks} of ${doc.totalChunks} chunks omitted by context budget`
        : `chunksIncluded=${doc.totalChunks}`,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" | ");

    const chunkLines = doc.chunks
      .map(
        (chunk) =>
          `[${index + 1}.${chunk.chunk_index}] ${chunk.content.trim()}`,
      )
      .join("\n\n");

    return `${headerParts}\n${chunkLines}`;
  });

  const instructions = [
    DOMAIN_GUARD_INSTRUCTION,
    "You are answering from retrieved knowledge base sources (books and YouTube transcripts).",
    "Read every provided source completely before answering. Each source contains all its chunks ordered by chunk_index.",
    "Write in the same language as the user's latest message (e.g. Georgian if they wrote Georgian).",
    "Style: thorough and explanatory, not telegraphic. Prefer several well-structured paragraphs over one short paragraph.",
    "Use clear structure when it helps: short section headings, numbered steps for procedures, and bullet lists only when they improve clarity (not as a substitute for full explanations).",
    "Return a comprehensive answer: explain the 'why' and 'how' when the sources support it, not only bare conclusions.",
    "Preserve all relevant rules, conditions, exceptions, dates, amounts, percentages, steps, formulas, fields, and caveats from the sources.",
    "For step-by-step or procedural questions (e.g. how to file, upload, or submit): include every step that appears in the sources for that procedure, in order, through the final step in the sources. Do not stop after an early numbered section if later chunks continue the same procedure.",
    "If multiple sources contribute, combine them into one coherent answer rather than relying on only the first match.",
    "Cite sources inline using [n] for whole-source references and [n.k] for specific chunks (n is the source number, k is the chunk_index).",
    context.truncated
      ? "Note: some source chunks were omitted to fit the context budget. If the user's question covers an area that may have been truncated, say so explicitly."
      : undefined,
    config.ragIncludeModelKnowledge
      ? 'If the sources do not fully answer the user, you may add general knowledge but mark that part clearly with the prefix "General knowledge:" so the user knows it is not from the sources.'
      : "If the sources do not answer the user, say what is missing instead of guessing.",
  ].filter((line): line is string => Boolean(line));

  let prompt = [
    ...instructions,
    "Retrieved knowledge base sources:",
    sections.join("\n\n"),
  ].join("\n\n");

  const cap = config.ragPromptCharHardCap;
  if (prompt.length > cap) {
    const notice =
      "\n\n[Context truncated by server hard cap to fit the model API; tail content from the last sources may be missing. Tell the user if this could affect completeness.]";
    prompt = prompt.slice(0, Math.max(0, cap - notice.length)) + notice;
  }

  return prompt;
}

function buildGeminiMessages(input: {
  history: Awaited<ReturnType<typeof getRecentMessages>>;
  context: ComprehensiveContext;
  content: string;
}): Content[] {
  const contextPrompt = buildContextPrompt(input.context);
  const historyMessages: Content[] = input.history.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  return [
    {
      role: "user",
      parts: [{ text: `${DOMAIN_GUARD_INSTRUCTION}\n\n${contextPrompt}` }],
    },
    ...historyMessages,
    {
      role: "user",
      parts: [{ text: input.content }],
    },
  ];
}

export interface ChatToolTraceEntry {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  latencyMs: number;
  error?: string;
}

interface PayrollPendingAction {
  type: "payroll_file";
  status: "pending";
  payrollRunId: string;
  approvalId: string;
  snapshotHash: string;
  expiresAt: string;
  periodYear: number;
  periodMonth: number;
  employeeCount: number;
  totalGross: number;
  totalIncomeTax: number;
  totalEmployeePension: number;
  totalEmployerPension: number;
  totalNet: number;
  warnings: string[];
}

function payrollPendingActionFromResult(result: unknown): PayrollPendingAction | undefined {
  const root = asJsonObject(result);
  const prepared = asJsonObject(root.prepared);
  const snapshot = asJsonObject(prepared.snapshot);
  const approval = asJsonObject(prepared.approval);
  if (
    root.requiresConfirmation !== true ||
    typeof prepared.payroll_run_id !== "string" ||
    typeof approval.id !== "string" ||
    typeof approval.snapshot_hash !== "string"
  ) {
    return undefined;
  }
  return {
    type: "payroll_file",
    status: "pending",
    payrollRunId: prepared.payroll_run_id,
    approvalId: approval.id,
    snapshotHash: approval.snapshot_hash,
    expiresAt: String(approval.expires_at ?? ""),
    periodYear: Number(snapshot.period_year) || 0,
    periodMonth: Number(snapshot.period_month) || 0,
    employeeCount: Number(snapshot.employee_count) || 0,
    totalGross: Number(snapshot.total_gross) || 0,
    totalIncomeTax: Number(snapshot.total_income_tax) || 0,
    totalEmployeePension: Number(snapshot.total_employee_pension) || 0,
    totalEmployerPension: Number(snapshot.total_employer_pension) || 0,
    totalNet: Number(snapshot.total_net) || 0,
    warnings: Array.isArray(snapshot.warnings)
      ? snapshot.warnings.map(String)
      : [],
  };
}

function pendingPayrollAction(trace: ChatToolTraceEntry[]): PayrollPendingAction | undefined {
  for (let index = trace.length - 1; index >= 0; index -= 1) {
    if (trace[index].name === "file_payroll") {
      const action = payrollPendingActionFromResult(trace[index].result);
      if (action) return action;
    }
  }
  return undefined;
}

function payrollPeriodFromText(content: string): { year: number; month: number } {
  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "numeric",
  }).formatToParts(new Date());
  let year = Number(nowParts.find((part) => part.type === "year")?.value);
  let month = Number(nowParts.find((part) => part.type === "month")?.value);
  const numeric = content.match(/\b(20\d{2})\s*[-/.]\s*(1[0-2]|0?[1-9])\b/);
  if (numeric) return { year: Number(numeric[1]), month: Number(numeric[2]) };

  const monthStems = [
    "იანვარ",
    "თებერვალ",
    "მარტ",
    "აპრილ",
    "მაის",
    "ივნის",
    "ივლის",
    "აგვისტ",
    "სექტემბერ",
    "ოქტომბერ",
    "ნოემბერ",
    "დეკემბერ",
  ];
  const lower = content.toLocaleLowerCase("ka-GE");
  const matchedMonth = monthStems.findIndex((stem) => lower.includes(stem));
  if (matchedMonth >= 0) month = matchedMonth + 1;
  const yearMatch = content.match(/\b(20\d{2})\b/);
  if (yearMatch) year = Number(yearMatch[1]);
  return { year, month };
}

function payrollPreviewText(action: PayrollPendingAction, attachmentWarnings: string[]): string {
  const money = (value: number) =>
    new Intl.NumberFormat("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      .format(value);
  const warnings = [...attachmentWarnings, ...action.warnings];
  return [
    `ხელფასების ფაილი დამუშავდა და ${action.periodMonth}/${action.periodYear} პერიოდის payroll მომზადდა.`,
    "",
    `თანამშრომლები: ${action.employeeCount}`,
    `დარიცხული ხელფასი: ${money(action.totalGross)} GEL`,
    `საშემოსავლო: ${money(action.totalIncomeTax)} GEL`,
    `თანამშრომლის პენსია: ${money(action.totalEmployeePension)} GEL`,
    `დამსაქმებლის პენსია: ${money(action.totalEmployerPension)} GEL`,
    `ხელზე გასაცემი: ${money(action.totalNet)} GEL`,
    ...(warnings.length ? ["", "გაფრთხილებები:", ...warnings.map((warning) => `- ${warning}`)] : []),
    "",
    "RS-ზე გასაგზავნად დაადასტურეთ ქვემოთ მოცემული ბარათი. დადასტურება 15 წუთში იწურება.",
  ].join("\n");
}

// ── Waybill-from-photo workflow ──────────────────────────────────────────

interface WaybillPendingAction {
  type: "waybill_send";
  status: "pending";
  attachmentId: string;
  approvalId: string; // == attachmentId; the frontend keys confirm state on approvalId
  snapshotHash: string;
  buyerName: string;
  buyerTin: string;
  sellerName?: string;
  startAddress?: string;
  endAddress?: string;
  itemCount: number;
  totalAmount: number;
  items: Array<{ name: string; quantity: number; price: number; unit?: string }>;
  warnings: string[];
}

interface WaybillSpreadsheetPendingAction {
  type: "waybill_spreadsheet_send";
  status: "pending";
  attachmentId: string;
  approvalId: string;
  snapshotHash: string;
  waybillCount: number;
  itemCount: number;
  totalAmount: number;
  preview: Array<{
    reference: string;
    buyerName: string;
    buyerTin: string;
    itemCount: number;
    totalAmount: number;
    warnings: string[];
  }>;
  warnings: string[];
}

/** Coerce a stored attachment `parsed_data` blob back into a WaybillExtraction. */
function asWaybillExtraction(value: unknown): WaybillExtraction {
  const o = asJsonObject(value);
  const items: WaybillItemFields[] = Array.isArray(o.items)
    ? o.items
        .map((raw): WaybillItemFields | null => {
          const item = asJsonObject(raw);
          const name = typeof item.w_name === "string" ? item.w_name : "";
          if (!name) return null;
          const entry: WaybillItemFields = {
            w_name: name,
            quantity: Number(item.quantity) || 0,
            price: Number(item.price) || 0,
          };
          if (typeof item.unit_txt === "string") entry.unit_txt = item.unit_txt;
          return entry;
        })
        .filter((i): i is WaybillItemFields => i !== null)
    : [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    is_waybill: o.is_waybill !== false && items.length > 0,
    confidence: Number(o.confidence) || 0,
    seller_name: str(o.seller_name),
    seller_tin: str(o.seller_tin),
    buyer_name: str(o.buyer_name),
    buyer_tin: str(o.buyer_tin),
    start_address: str(o.start_address),
    end_address: str(o.end_address),
    driver_name: str(o.driver_name),
    driver_tin: str(o.driver_tin),
    car_number: str(o.car_number),
    document_number: str(o.document_number),
    begin_date: str(o.begin_date),
    items,
    warnings: Array.isArray(o.warnings) ? o.warnings.map(String).filter(Boolean) : [],
  };
}

/**
 * Stable hash of the fields that get filed to rs.ge. Lets the confirm step
 * detect that the data the user approved still matches the stored attachment
 * (defends against a re-upload race between preview and confirm).
 */
function waybillSnapshotHash(extraction: WaybillExtraction): string {
  const canonical = JSON.stringify({
    buyer_tin: extraction.buyer_tin ?? "",
    buyer_name: extraction.buyer_name ?? "",
    start_address: extraction.start_address ?? "",
    end_address: extraction.end_address ?? "",
    items: extraction.items.map((i) => [i.w_name, i.quantity, i.price, i.unit_txt ?? ""]),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function waybillPreviewText(action: WaybillPendingAction, extraction: WaybillExtraction): string {
  const money = (value: number) =>
    new Intl.NumberFormat("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const lines = action.items
    .slice(0, 10)
    .map((i) => `- ${i.name}: ${i.quantity} × ${money(i.price)} = ${money(i.quantity * i.price)} GEL`);
  const moreCount = action.items.length - Math.min(action.items.length, 10);
  return [
    "ფოტოდან ზედნადები წავიკითხე. გადაამოწმეთ მონაცემები და დაადასტურეთ გასაგზავნად.",
    "",
    `მყიდველი: ${action.buyerName || "—"}${action.buyerTin ? ` (ს/კ ${action.buyerTin})` : ""}`,
    ...(action.startAddress ? [`გაგზავნის მისამართი: ${action.startAddress}`] : []),
    ...(action.endAddress ? [`ჩაბარების მისამართი: ${action.endAddress}`] : []),
    "",
    `საქონელი (${action.itemCount}):`,
    ...lines,
    ...(moreCount > 0 ? [`… და კიდევ ${moreCount} პოზიცია`] : []),
    "",
    `ჯამი: ${money(action.totalAmount)} GEL`,
    ...(action.warnings.length ? ["", "გასათვალისწინებელი:", ...action.warnings.map((w) => `- ${w}`)] : []),
    "",
    "ქვემოთ მოცემული ღილაკით გააგზავნეთ rs.ge-ზე.",
  ].join("\n");
}

/**
 * Build the assistant reply + confirm card from an uploaded waybill photo.
 * Reads the extraction stored on the attachment at upload time (no re-vision).
 * Returns NO pendingAction when the image isn't a usable waybill or the buyer
 * TIN (required by rs.ge) couldn't be read — in those cases the user is asked
 * to clarify rather than shown a send button.
 */
function buildWaybillWorkflowResult(imageAttachments: ChatAttachmentRow[]): {
  text: string;
  pendingAction?: WaybillPendingAction;
} {
  const chosen =
    imageAttachments.find((a) => a.status !== "rejected") ??
    imageAttachments[imageAttachments.length - 1];
  if (chosen.status === "sent") {
    return {
      text: "ეს ზედნადები უკვე გაგზავნილია rs.ge-ზე.",
    };
  }
  const extraction = asWaybillExtraction(chosen.parsed_data);

  if (!extraction.is_waybill || extraction.items.length === 0) {
    return {
      text: [
        "ამ ფოტოზე ზედნადები ვერ ამოვიცანი.",
        "გთხოვთ ატვირთოთ ზედნადების მკაფიო ფოტო, სადაც ჩანს მყიდველი, საქონელი, რაოდენობა და ფასი.",
      ].join("\n"),
    };
  }

  if (!extraction.buyer_tin) {
    return {
      text: [
        "ფოტოდან ზედნადები წავიკითხე, მაგრამ მყიდველის საიდენტიფიკაციო ნომერი (ს/კ) ვერ ამოვიკითხე — ის rs.ge-ზე გასაგზავნად აუცილებელია.",
        "გთხოვთ ატვირთოთ ფოტო, სადაც მყიდველის ს/კ მკაფიოდ ჩანს.",
        ...(extraction.warnings.length ? ["", ...extraction.warnings.map((w) => `- ${w}`)] : []),
      ].join("\n"),
    };
  }

  const total = extraction.items.reduce((sum, i) => sum + i.quantity * i.price, 0);
  const warnings = [...extraction.warnings];
  if (extraction.confidence > 0 && extraction.confidence < 0.6) {
    warnings.unshift("ამოკითხვის სანდოობა დაბალია — განსაკუთრებით ყურადღებით გადაამოწმეთ.");
  }

  const action: WaybillPendingAction = {
    type: "waybill_send",
    status: "pending",
    attachmentId: chosen.id,
    approvalId: chosen.id,
    snapshotHash: waybillSnapshotHash(extraction),
    buyerName: extraction.buyer_name ?? "",
    buyerTin: extraction.buyer_tin,
    sellerName: extraction.seller_name,
    startAddress: extraction.start_address,
    endAddress: extraction.end_address,
    itemCount: extraction.items.length,
    totalAmount: +total.toFixed(2),
    items: extraction.items.slice(0, 20).map((i) => ({
      name: i.w_name,
      quantity: i.quantity,
      price: i.price,
      unit: i.unit_txt,
    })),
    warnings,
  };

  return { text: waybillPreviewText(action, extraction), pendingAction: action };
}

function asWaybillSpreadsheetDrafts(value: unknown): {
  drafts: WaybillSpreadsheetDraft[];
  warnings: string[];
} {
  const parsed = asJsonObject(value);
  const warnings = Array.isArray(parsed.warnings)
    ? parsed.warnings.map(String).filter(Boolean)
    : [];
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const drafts: WaybillSpreadsheetDraft[] = Array.isArray(parsed.drafts)
    ? parsed.drafts
        .map((raw, idx): WaybillSpreadsheetDraft | null => {
          const d = asJsonObject(raw);
          const items: WaybillSpreadsheetDraft["items"] = Array.isArray(d.items)
            ? d.items
                .map((rawItem): WaybillSpreadsheetDraft["items"][number] | null => {
                  const item = asJsonObject(rawItem);
                  const name = str(item.w_name);
                  if (!name) return null;
                  return {
                    w_name: name,
                    unit_txt: str(item.unit_txt),
                    quantity: Number(item.quantity) || 0,
                    price: Number(item.price) || 0,
                    source_row: Number(item.source_row) || 0,
                  };
                })
                .filter((item): item is WaybillSpreadsheetDraft["items"][number] => item !== null)
            : [];
          const total = items.reduce((sum, item) => sum + item.quantity * item.price, 0);
          return {
            reference: str(d.reference) ?? `draft-${idx + 1}`,
            buyer_name: str(d.buyer_name),
            buyer_tin: str(d.buyer_tin),
            start_address: str(d.start_address),
            end_address: str(d.end_address),
            driver_name: str(d.driver_name),
            driver_tin: str(d.driver_tin),
            car_number: str(d.car_number),
            document_number: str(d.document_number),
            begin_date: str(d.begin_date),
            items,
            source_rows: Array.isArray(d.source_rows)
              ? d.source_rows.map(Number).filter((n) => Number.isFinite(n))
              : [],
            total_amount: Number(d.total_amount) || Math.round(total * 100) / 100,
            warnings: Array.isArray(d.warnings)
              ? d.warnings.map(String).filter(Boolean)
              : [],
          };
        })
        .filter((draft): draft is WaybillSpreadsheetDraft => draft !== null)
    : [];
  return { drafts, warnings };
}

function waybillExtractionFromSpreadsheetDraft(
  draft: WaybillSpreadsheetDraft,
): WaybillExtraction {
  return {
    is_waybill: draft.items.length > 0,
    confidence: 1,
    buyer_name: draft.buyer_name,
    buyer_tin: draft.buyer_tin,
    start_address: draft.start_address,
    end_address: draft.end_address,
    driver_name: draft.driver_name,
    driver_tin: draft.driver_tin,
    car_number: draft.car_number,
    document_number: draft.document_number,
    begin_date: draft.begin_date,
    items: draft.items.map((item) => ({
      w_name: item.w_name,
      unit_txt: item.unit_txt,
      quantity: item.quantity,
      price: item.price,
    })),
    warnings: draft.warnings,
  };
}

function stableReferencePart(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function waybillSpreadsheetSnapshotHash(drafts: WaybillSpreadsheetDraft[]): string {
  const canonical = JSON.stringify(
    drafts.map((draft) => ({
      reference: draft.reference,
      buyer_tin: draft.buyer_tin ?? "",
      buyer_name: draft.buyer_name ?? "",
      start_address: draft.start_address ?? "",
      end_address: draft.end_address ?? "",
      items: draft.items.map((i) => [i.w_name, i.quantity, i.price, i.unit_txt ?? ""]),
    })),
  );
  return createHash("sha256").update(canonical).digest("hex");
}

function waybillSpreadsheetPreviewText(
  action: WaybillSpreadsheetPendingAction,
): string {
  const money = (value: number) =>
    new Intl.NumberFormat("ka-GE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  const rows = action.preview.map(
    (draft) =>
      `- ${draft.reference}: ${draft.buyerName || "მყიდველი"} (ს/კ ${draft.buyerTin}) · ${draft.itemCount} პოზიცია · ${money(draft.totalAmount)} GEL`,
  );
  const more = action.waybillCount - action.preview.length;
  return [
    "Excel ფაილიდან ზედნადებები წავიკითხე. გადაამოწმეთ სია და მხოლოდ შემდეგ დაადასტურეთ RS.ge-ზე გაგზავნა.",
    "თუ ეს Shopify/ICS შეკვეთებია, უფრო უსაფრთხო გზაა ჩატში თარიღით მოთხოვნა: \"ატვირთე ზედნადებები დღევანდელი შეკვეთებისთვის\" — მაშინ სისტემა ICS case/tracking-ს Shopify order-თან შეადარებს და მხოლოდ დადასტურებულ order-ებს ატვირთავს.",
    "Excel გამოიყენეთ მაშინ, როცა ეს მონაცემები Shopify order-ებში არ არის ან ხელით მიღებული ზედნადებებია. ასეთ ფაილში აუცილებლად დატოვეთ order/case/document reference, buyer TIN, buyer name, start/end address, item, quantity და price.",
    "",
    `ზედნადებები: ${action.waybillCount}`,
    `საქონლის პოზიციები: ${action.itemCount}`,
    `ჯამი: ${money(action.totalAmount)} GEL`,
    "",
    ...rows,
    ...(more > 0 ? [`… და კიდევ ${more} ზედნადები`] : []),
    ...(action.warnings.length ? ["", "გასათვალისწინებელი:", ...action.warnings.map((w) => `- ${w}`)] : []),
    "",
    "ქვემოთ მოცემული ღილაკით ყველა ეს ზედნადები გაიგზავნება rs.ge-ზე.",
  ].join("\n");
}

function buildWaybillSpreadsheetWorkflowResult(attachments: ChatAttachmentRow[]): {
  text: string;
  pendingAction?: WaybillSpreadsheetPendingAction;
} {
  const chosen =
    attachments.find((a) => a.status !== "rejected") ?? attachments[attachments.length - 1];
  if (chosen.status === "sent") {
    return { text: "ამ Excel ფაილის ზედნადებები უკვე გაგზავნილია rs.ge-ზე." };
  }
  const { drafts, warnings } = asWaybillSpreadsheetDrafts(chosen.parsed_data);
  if (!drafts.length) {
    return {
      text: [
        "Excel ფაილში გასაგზავნი ზედნადების სტრიქონები ვერ ვიპოვე.",
        "საჭიროა მინიმუმ ეს სვეტები: buyer TIN / მყიდველის ს/კ, item / საქონელი, quantity / რაოდენობა, price / ფასი.",
        "თუ ეს Shopify/ICS შეკვეთებია, Excel-ის ნაცვლად ჩატში თარიღით სთხოვეთ: \"ატვირთე ზედნადებები დღევანდელი შეკვეთებისთვის\" — სისტემა თვითონ შეამოწმებს ICS case/tracking-ს Shopify order-ებთან.",
        ...(warnings.length ? ["", ...warnings.map((w) => `- ${w}`)] : []),
      ].join("\n"),
    };
  }

  const invalidDrafts = drafts.filter((draft) => !isSendableWaybillDraft(draft));
  if (invalidDrafts.length > 0) {
    const details = invalidDrafts.slice(0, 8).map((draft) => {
      const draftWarnings = draft.warnings.length
        ? draft.warnings.join("; ")
        : "missing required buyer/address/item fields";
      return `- ${draft.reference}: ${draftWarnings}`;
    });
    return {
      text: [
        "Excel ფაილი წავიკითხე, მაგრამ RS.ge-ზე გასაგზავნად რამდენიმე ზედნადებს სავალდებულო მონაცემები აკლია.",
        "",
        ...details,
        ...(invalidDrafts.length > details.length
          ? [`… და კიდევ ${invalidDrafts.length - details.length} ზედნადები`]
          : []),
        "",
        "გაასწორეთ Excel-ში მყიდველის ს/კ, მყიდველის დასახელება, გასვლის/დანიშნულების მისამართები და საქონლის რაოდენობა/ფასი, შემდეგ ხელახლა ატვირთეთ.",
        "თუ ეს მონაცემები Shopify/ICS-დან მოდის, ჯობია გამოიყენოთ order-based ატვირთვა თარიღით, რომ სისტემა Shopify order-სა და ICS shipment-ს ერთმანეთთან შეადარებს.",
      ].join("\n"),
    };
  }

  const itemCount = drafts.reduce((sum, draft) => sum + draft.items.length, 0);
  const totalAmount = drafts.reduce((sum, draft) => sum + draft.total_amount, 0);
  const draftWarnings = drafts.flatMap((draft) =>
    draft.warnings.map((warning) => `${draft.reference}: ${warning}`),
  );
  const action: WaybillSpreadsheetPendingAction = {
    type: "waybill_spreadsheet_send",
    status: "pending",
    attachmentId: chosen.id,
    approvalId: chosen.id,
    snapshotHash: waybillSpreadsheetSnapshotHash(drafts),
    waybillCount: drafts.length,
    itemCount,
    totalAmount: Math.round(totalAmount * 100) / 100,
    preview: drafts.slice(0, 10).map((draft) => ({
      reference: draft.reference,
      buyerName: draft.buyer_name ?? "",
      buyerTin: draft.buyer_tin ?? "",
      itemCount: draft.items.length,
      totalAmount: draft.total_amount,
      warnings: draft.warnings,
    })),
    warnings: [...warnings, ...draftWarnings],
  };

  return {
    text: waybillSpreadsheetPreviewText(action),
    pendingAction: action,
  };
}

function looksLikeWaybillCorrection(text: string): boolean {
  return (
    /(შეცვალ|შეასწორ|არასწორ|ნაცვლად|უნდა იყოს|instead|correct)/i.test(text) ||
    /(ფასი|რაოდენ|ს\/კ|მყიდველ|მისამართ|price|quantity|qty|buyer|tin|address)/i.test(text) ||
    (/არა/i.test(text) && /\d/.test(text))
  );
}

async function runToolLoop(
  gemini: GeminiService,
  systemInstruction: string,
  initialContents: Content[],
  ctx: { companyId: string; userId?: string },
  options: { voiceMode?: boolean } = {},
): Promise<{ text: string; model: string; trace: ChatToolTraceEntry[]; iterations: number }> {
  const tools = toolDeclarations();
  const trace: ChatToolTraceEntry[] = [];
  let contents = [...initialContents];
  let model = "";
  const maxIterations = Math.max(1, config.chatToolMaxIterations);

  for (let i = 0; i < maxIterations; i++) {
    const turn = await gemini.generateWithTools({
      systemInstruction,
      contents,
      tools,
      toolChoice: "auto",
      ...(options.voiceMode
        ? { temperature: 0.65, maxOutputTokens: VOICE_MAX_OUTPUT_TOKENS }
        : {}),
    });
    model = turn.model;

    if (!turn.functionCalls || turn.functionCalls.length === 0) {
      if (turn.text) {
        return { text: turn.text, model, trace, iterations: i + 1 };
      }
      // No tool calls AND no text — unusual; fall through to a final
      // coercive call with toolChoice=none below.
      break;
    }

    // Append the model's tool-call turn so subsequent turns see the
    // call alongside our response (Gemini requires this pairing). Echo the
    // RAW model content when available — its functionCall parts carry a
    // `thoughtSignature` that thinking models require on the next request;
    // rebuilding the parts by hand drops that signature and Gemini 400s.
    //
    // Derive the calls to dispatch from the SAME source we echo, in part
    // order, so our functionResponse parts line up 1:1 and positionally with
    // the model's functionCall parts (Gemini pairs them by position).
    const echoedParts = turn.modelContent?.parts ?? [];
    let calls: FunctionCall[];
    if (echoedParts.length) {
      contents.push(turn.modelContent as Content);
      const fromParts = echoedParts
        .filter((p) => p.functionCall)
        .map((p) => p.functionCall as FunctionCall);
      calls = fromParts.length ? fromParts : turn.functionCalls;
    } else {
      calls = turn.functionCalls;
      contents.push({
        role: "model",
        parts: calls.map((call: FunctionCall) => ({
          functionCall: { name: call.name ?? "", args: call.args ?? {} },
        })),
      });
    }

    const responseParts = await Promise.all(
      calls.map(async (call: FunctionCall) => {
        const name = call.name ?? "";
        const args = (call.args ?? {}) as Record<string, unknown>;
        const t0 = Date.now();
        let result: unknown;
        let error: string | undefined;
        try {
          result = await dispatchTool(name, args, ctx);
          if (
            result &&
            typeof result === "object" &&
            !Array.isArray(result) &&
            "error" in (result as Record<string, unknown>)
          ) {
            error = String((result as Record<string, unknown>).error);
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          result = { error };
        }
        trace.push({
          name,
          args,
          result,
          latencyMs: Date.now() - t0,
          ...(error ? { error } : {}),
        });
        return {
          functionResponse: {
            name,
            response: { result },
          },
        };
      }),
    );

    contents.push({ role: "user", parts: responseParts });
  }

  // Iteration cap hit — force a final text answer.
  const finalTurn = await gemini.generateWithTools({
    systemInstruction:
      systemInstruction +
      "\n\nNOTE: The tool-call iteration limit has been reached. Summarize what you found so far and answer the user — do NOT call any more tools.",
    contents,
    tools,
    toolChoice: "none",
    ...(options.voiceMode
      ? { temperature: 0.65, maxOutputTokens: VOICE_MAX_OUTPUT_TOKENS }
      : {}),
  });
  return {
    text: finalTurn.text || "(no answer)",
    model: finalTurn.model || model,
    trace,
    iterations: maxIterations,
  };
}

export async function sendConversationMessage(
  input: {
    companyId: string;
    conversationId: string;
    content: string;
    metadata: Record<string, unknown>;
    userId?: string;
    attachmentIds?: string[];
  },
  gemini: GeminiService = geminiService,
) {
  const content = input.content.trim();

  if (!content) {
    throw new HttpError(400, "content is required");
  }

  const conversation = await getConversation(input.companyId, input.conversationId);

  if (!conversation) {
    throw new HttpError(404, "Conversation not found");
  }
  if (conversation.user_id && input.userId && conversation.user_id !== input.userId) {
    throw new HttpError(403, "Conversation belongs to another user");
  }

  // Per-company per-hour rate limit. Throws 429 when over cap; the
  // bump itself IS the check, so two concurrent requests can't race
  // past the limit. Set CHAT_MAX_MSGS_PER_HOUR=0 to disable.
  await checkAndBumpChatLimit(input.companyId);

  const voiceMode = input.metadata.voiceMode === true;
  const guardedReply = domainGuardReply(content, voiceMode);
  if (guardedReply) {
    const persisted = await persistChatTurn({
      conversationId: input.conversationId,
      userContent: content,
      userMetadata: input.metadata,
      assistantContent: guardedReply,
      assistantModel: DOMAIN_GUARD_MODEL,
      assistantMetadata: {
        domainGuard: {
          blocked: true,
          allowedScope:
            "finance/accounting/tax/payroll/rs.ge/Declario/business operations",
        },
        voiceMode,
      },
      contexts: [],
    });
    return {
      ...persisted,
      contexts: [],
    };
  }

  const history = await getRecentMessages(input.conversationId);
  const attachments = await getChatAttachments({
    companyId: input.companyId,
    conversationId: input.conversationId,
    attachmentIds: input.attachmentIds ?? [],
    userId: input.userId,
  });
  if (attachments.length !== (input.attachmentIds ?? []).length) {
    throw new HttpError(404, "One or more attachments were not found");
  }
  const payrollAttachments = attachments.filter(
    (attachment) => attachment.kind === "payroll_spreadsheet",
  );
  let imageAttachments = attachments.filter(
    (attachment) => attachment.kind === "image",
  );
  const waybillSpreadsheetAttachments = attachments.filter(
    (attachment) => attachment.kind === "waybill_spreadsheet",
  );
  if (attachments.length === 0 && looksLikeWaybillCorrection(content)) {
    const latestImage = await getLatestParsedAttachment({
      companyId: input.companyId,
      conversationId: input.conversationId,
      kind: "image",
      userId: input.userId,
    });
    if (latestImage) {
      try {
        const correction = await applyWaybillCorrection(
          asWaybillExtraction(latestImage.parsed_data),
          content,
        );
        if (correction.changed) {
          const parsedData = correction.extraction as unknown as Record<string, unknown>;
          const updated = await updateChatAttachmentParsedData({
            companyId: input.companyId,
            attachmentId: latestImage.id,
            parsedData,
            status: "parsed",
          });
          imageAttachments = [updated ?? { ...latestImage, parsed_data: parsedData }];
        }
      } catch (error) {
        console.warn("[chat] waybill correction failed:", error);
      }
    }
  }
  // Attachment-driven workflows (payroll sheet, waybill photo) answer from the
  // uploaded data, not the book corpus — skip the slow RAG embed.
  const diagnosticMode =
    payrollAttachments.length ||
    imageAttachments.length ||
    waybillSpreadsheetAttachments.length
      ? true
      : looksLikeDiagnosticQuery(content);

  // Diagnostic queries skip the RAG embed: the answer lives in live data,
  // not the book corpus, and the embed call is the slowest single step.
  let context: ComprehensiveContext = emptyContext();
  if (!diagnosticMode && !voiceMode) {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await gemini.embed(formatQueryForEmbedding(content));
    } catch (error) {
      console.warn(
        "[chat] Gemini embed failed; continuing without RAG context:",
        getUpstreamErrorMessage(error),
      );
      queryEmbedding = [];
    }
    if (queryEmbedding.length > 0) {
      context = await gatherComprehensiveContext(queryEmbedding);
    }
  }

  let assistant: { text: string; model: string };
  let toolTrace: ChatToolTraceEntry[] = [];
  let toolIterations = 0;
  let pendingActionForMessage:
    | PayrollPendingAction
    | WaybillPendingAction
    | WaybillSpreadsheetPendingAction
    | undefined;
  try {
    if (imageAttachments.length) {
      const waybillResult = buildWaybillWorkflowResult(imageAttachments);
      assistant = {
        text: waybillResult.text,
        model: "declario-waybill-vision-v1",
      };
      pendingActionForMessage = waybillResult.pendingAction;
      toolIterations = 1;
    } else if (waybillSpreadsheetAttachments.length) {
      const waybillSpreadsheetResult = buildWaybillSpreadsheetWorkflowResult(
        waybillSpreadsheetAttachments,
      );
      assistant = {
        text: waybillSpreadsheetResult.text,
        model: "declario-waybill-spreadsheet-v1",
      };
      pendingActionForMessage = waybillSpreadsheetResult.pendingAction;
      toolIterations = 1;
    } else if (payrollAttachments.length) {
      const employees = payrollAttachments.flatMap((attachment) => {
        const parsed = asJsonObject(attachment.parsed_data);
        return Array.isArray(parsed.employees)
          ? parsed.employees.map((employee) => {
              const row = asJsonObject(employee);
              return {
                name: String(row.name ?? ""),
                gross: Number(row.gross) || 0,
                ...(typeof row.personal_id === "string"
                  ? { personal_id: row.personal_id }
                  : {}),
                pension_participant: row.pension_participant !== false,
              };
            })
          : [];
      });
      if (!employees.length) {
        throw new HttpError(400, "The attached payroll file has no valid employee rows");
      }
      const importStarted = Date.now();
      const importResult = await dispatchTool(
        "import_employees",
        { employees },
        { companyId: input.companyId, userId: input.userId },
      );
      toolTrace.push({
        name: "import_employees",
        args: { employeeCount: employees.length },
        result: importResult,
        latencyMs: Date.now() - importStarted,
      });
      if ("error" in asJsonObject(importResult)) {
        throw new HttpError(502, String(asJsonObject(importResult).error));
      }

      const period = payrollPeriodFromText(content);
      const prepareStarted = Date.now();
      const prepareResult = await dispatchTool(
        "file_payroll",
        { year: period.year, month: period.month },
        { companyId: input.companyId, userId: input.userId },
      );
      toolTrace.push({
        name: "file_payroll",
        args: period,
        result: prepareResult,
        latencyMs: Date.now() - prepareStarted,
      });
      const action = payrollPendingActionFromResult(prepareResult);
      if (!action) {
        const error = asJsonObject(asJsonObject(prepareResult).prepared).error;
        throw new HttpError(502, String(error ?? "Payroll preview could not be prepared"));
      }
      const attachmentWarnings = payrollAttachments.flatMap((attachment) => {
        const warnings = asJsonObject(attachment.parsed_data).warnings;
        return Array.isArray(warnings) ? warnings.map(String) : [];
      });
      assistant = {
        text: payrollPreviewText(action, attachmentWarnings),
        model: "declario-payroll-workflow-v1",
      };
      pendingActionForMessage = action;
      toolIterations = 2;
    } else {
    const baseMessages = buildGeminiMessages({ history, context, content });
      const toolLoopResult = await runToolLoop(
      gemini,
      voiceMode
        ? `${DOMAIN_GUARD_INSTRUCTION}\n\n${chatToolSystemInstruction()}\n\n${VOICE_SYSTEM_INSTRUCTION}`
        : `${DOMAIN_GUARD_INSTRUCTION}\n\n${chatToolSystemInstruction()}`,
      baseMessages,
      { companyId: input.companyId, userId: input.userId },
      { voiceMode },
    );
    assistant = { text: toolLoopResult.text, model: toolLoopResult.model };
    toolTrace = toolLoopResult.trace;
    toolIterations = toolLoopResult.iterations;
    pendingActionForMessage = pendingPayrollAction(toolTrace);
    }
  } catch (error) {
    console.error("[chat] Gemini generateContent failed:", error);
    throw new HttpError(502, `Gemini chat failed: ${getUpstreamErrorMessage(error)}`);
  }

  const persisted = await persistChatTurn({
    conversationId: input.conversationId,
    userContent: content,
    userMetadata: input.metadata,
    assistantContent: assistant.text,
    assistantModel: assistant.model,
    assistantMetadata: {
      pendingAction: pendingActionForMessage,
      attachments: [
        ...payrollAttachments,
        ...imageAttachments,
        ...waybillSpreadsheetAttachments,
      ].map((attachment) => ({
        id: attachment.id,
        name: attachment.original_name,
        kind: attachment.kind,
        status: attachment.status,
      })),
      tools:
        toolTrace.length > 0
          ? {
              iterations: toolIterations,
              calls: toolTrace.map((t) => ({
                name: t.name,
                args: t.args,
                latencyMs: t.latencyMs,
                error: t.error,
                // We deliberately do NOT persist full tool results in
                // metadata to keep row size sane; the UI shows args +
                // status only. Re-run the tool if a user wants the data.
              })),
            }
          : undefined,
      diagnosticMode,
      voiceMode,
      rag: {
        topK: config.ragTopK,
        documentLimit: config.ragDocumentLimit,
        maxContextChars: config.ragMaxContextChars,
        promptCharHardCap: config.ragPromptCharHardCap,
        chunkAnchorWindow: config.ragChunkAnchorWindow,
        chatTemperature: config.geminiChatTemperature,
        includeModelKnowledge: config.ragIncludeModelKnowledge,
        selectedBookIds: context.selectedBookIds,
        totalDocuments: context.totalDocuments,
        totalChunks: context.totalChunks,
        includedChunks: context.includedChunks,
        truncated: context.truncated,
        documents: context.documents.map((doc) => ({
          bookId: doc.bookId,
          title: doc.title,
          chunksIncluded: doc.chunks.length,
          chunksTotal: doc.totalChunks,
          chunksDropped: doc.droppedChunks,
          seedSimilarity: doc.seedSimilarity,
        })),
        contexts: context.contexts.map((chunk) => {
          const meta = asJsonObject(chunk.metadata);
          return {
            bookChunkId: chunk.id,
            bookId: chunk.book_id,
            chunkIndex: chunk.chunk_index,
            rank: chunk.rank,
            similarity: chunk.similarity,
            contentPreview: clipChunkPreviewForMetadata(
              chunk.content,
              RAG_CONTEXT_PREVIEW_CHARS,
            ),
            sourceUrl: chunkSourceUrl(meta),
          };
        }),
      },
    },
    contexts: context.contexts,
  });

  return {
    ...persisted,
    contexts: context.contexts,
  };
}

export async function confirmPayrollAction(input: {
  companyId: string;
  conversationId: string;
  userId?: string;
  payrollRunId: string;
  approvalId: string;
  snapshotHash: string;
}) {
  if (!input.userId) throw new HttpError(401, "Authenticated user is required");
  const conversation = await getConversation(input.companyId, input.conversationId);
  if (!conversation) throw new HttpError(404, "Conversation not found");
  if (conversation.user_id && conversation.user_id !== input.userId) {
    throw new HttpError(403, "Conversation belongs to another user");
  }
  return rsServerClient.post("/internal/tools/payroll/file", {
    companyId: input.companyId,
    userId: input.userId,
    body: {
      payroll_run_id: input.payrollRunId,
      approval_id: input.approvalId,
      snapshot_hash: input.snapshotHash,
    },
  });
}

export async function confirmWaybillAction(input: {
  companyId: string;
  conversationId: string;
  userId?: string;
  attachmentId: string;
  snapshotHash?: string;
}) {
  const conversation = await getConversation(input.companyId, input.conversationId);
  if (!conversation) throw new HttpError(404, "Conversation not found");
  if (conversation.user_id && input.userId && conversation.user_id !== input.userId) {
    throw new HttpError(403, "Conversation belongs to another user");
  }

  const attachment = await getChatAttachmentById({
    companyId: input.companyId,
    conversationId: input.conversationId,
    attachmentId: input.attachmentId,
    userId: input.userId,
  });
  if (!attachment || attachment.kind !== "image") {
    throw new HttpError(404, "Waybill attachment not found");
  }

  // Idempotency: a second confirm (double-click / retry) must NOT file a
  // second waybill on rs.ge. Once sent, return the stored result.
  if (attachment.status === "sent") {
    const prior = asJsonObject(attachment.parsed_data).sent_result;
    return { alreadySent: true, result: prior ?? null };
  }

  const extraction = asWaybillExtraction(attachment.parsed_data);
  if (!extraction.is_waybill || extraction.items.length === 0) {
    throw new HttpError(400, "This attachment isn't a recognized waybill");
  }
  if (!extraction.buyer_tin) {
    throw new HttpError(400, "Buyer TIN is missing — cannot file the waybill");
  }
  if (input.snapshotHash && waybillSnapshotHash(extraction) !== input.snapshotHash) {
    throw new HttpError(
      409,
      "The waybill data changed since you reviewed it — re-check and try again",
    );
  }

  // Atomic claim: flip 'parsed' → 'sent' so a concurrent confirm (double
  // click) can't file the same waybill twice on rs.ge.
  const claimed = await claimImageAttachmentForSend({
    companyId: input.companyId,
    attachmentId: attachment.id,
  });
  if (!claimed) {
    const fresh = await getChatAttachmentById({
      companyId: input.companyId,
      conversationId: input.conversationId,
      attachmentId: input.attachmentId,
      userId: input.userId,
    });
    return {
      alreadySent: true,
      result: asJsonObject(fresh?.parsed_data).sent_result ?? null,
    };
  }

  const payload = {
    reference: `photo:${attachment.id}`,
    send: true,
    buyer_tin: extraction.buyer_tin,
    buyer_name: extraction.buyer_name ?? "",
    start_address: extraction.start_address,
    end_address: extraction.end_address,
    driver_tin: extraction.driver_tin,
    driver_name: extraction.driver_name,
    car_number: extraction.car_number,
    begin_date: extraction.begin_date,
    items: extraction.items.map((i) => ({
      w_name: i.w_name,
      unit_txt: i.unit_txt,
      quantity: i.quantity,
      price: i.price,
    })),
  };

  let result: Record<string, unknown>;
  try {
    result = await rsServerClient.post<Record<string, unknown>>(
      "/internal/tools/waybills/save-and-send",
      { companyId: input.companyId, userId: input.userId, body: payload },
    );
  } catch (error) {
    // Pre-send failure (e.g. rs.ge validation rejected it, no waybill was
    // created) — release the claim so the user can fix and retry.
    await markChatAttachmentStatus({
      companyId: input.companyId,
      attachmentId: attachment.id,
      status: "parsed",
    }).catch(() => undefined);
    throw error;
  }

  await markChatAttachmentStatus({
    companyId: input.companyId,
    attachmentId: attachment.id,
    status: "sent",
    mergeParsedData: { sent_result: result },
  });

  return result;
}

export async function confirmWaybillSpreadsheetAction(input: {
  companyId: string;
  conversationId: string;
  userId?: string;
  attachmentId: string;
  snapshotHash?: string;
}) {
  const conversation = await getConversation(input.companyId, input.conversationId);
  if (!conversation) throw new HttpError(404, "Conversation not found");
  if (conversation.user_id && input.userId && conversation.user_id !== input.userId) {
    throw new HttpError(403, "Conversation belongs to another user");
  }

  const attachment = await getChatAttachmentById({
    companyId: input.companyId,
    conversationId: input.conversationId,
    attachmentId: input.attachmentId,
    userId: input.userId,
  });
  if (!attachment || attachment.kind !== "waybill_spreadsheet") {
    throw new HttpError(404, "Waybill spreadsheet attachment not found");
  }

  if (attachment.status === "sent") {
    const prior = asJsonObject(attachment.parsed_data).sent_result;
    return { alreadySent: true, result: prior ?? null };
  }

  const { drafts } = asWaybillSpreadsheetDrafts(attachment.parsed_data);
  if (!drafts.length) {
    throw new HttpError(400, "This spreadsheet has no valid waybill drafts");
  }
  const invalidDrafts = drafts.filter((draft) => !isSendableWaybillDraft(draft));
  if (invalidDrafts.length > 0) {
    throw new HttpError(
      400,
      `Spreadsheet has ${invalidDrafts.length} waybill draft(s) with missing required fields`,
    );
  }
  if (input.snapshotHash && waybillSpreadsheetSnapshotHash(drafts) !== input.snapshotHash) {
    throw new HttpError(
      409,
      "The spreadsheet waybill data changed since you reviewed it — re-check and try again",
    );
  }

  const claimed = await claimAttachmentForSend({
    companyId: input.companyId,
    attachmentId: attachment.id,
    kind: "waybill_spreadsheet",
  });
  if (!claimed) {
    const fresh = await getChatAttachmentById({
      companyId: input.companyId,
      conversationId: input.conversationId,
      attachmentId: input.attachmentId,
      userId: input.userId,
    });
    return {
      alreadySent: true,
      result: asJsonObject(fresh?.parsed_data).sent_result ?? null,
    };
  }

  const results: Array<Record<string, unknown>> = [];
  const failures: Array<{ reference: string; error: string }> = [];
  for (const draft of drafts) {
    const extraction = waybillExtractionFromSpreadsheetDraft(draft);
    const reference = `spreadsheet:${attachment.id}:${stableReferencePart(draft.reference)}`;
    const payload = {
      reference,
      send: true,
      buyer_tin: extraction.buyer_tin,
      buyer_name: extraction.buyer_name ?? "",
      start_address: extraction.start_address,
      end_address: extraction.end_address,
      driver_tin: extraction.driver_tin,
      driver_name: extraction.driver_name,
      car_number: extraction.car_number,
      begin_date: extraction.begin_date,
      comment: draft.document_number
        ? `Imported from spreadsheet document ${draft.document_number}`
        : "Imported from spreadsheet",
      items: extraction.items.map((i) => ({
        w_name: i.w_name,
        unit_txt: i.unit_txt,
        quantity: i.quantity,
        price: i.price,
      })),
    };

    try {
      const result = await rsServerClient.post<Record<string, unknown>>(
        "/internal/tools/waybills/save-and-send",
        { companyId: input.companyId, userId: input.userId, body: payload },
      );
      results.push({ reference: draft.reference, ...result });
    } catch (error) {
      failures.push({ reference: draft.reference, error: getUpstreamErrorMessage(error) });
    }
  }

  const summary = {
    sent: results.length,
    failed: failures.length,
    results,
    failures,
  };

  if (failures.length > 0) {
    await markChatAttachmentStatus({
      companyId: input.companyId,
      attachmentId: attachment.id,
      status: "parsed",
      mergeParsedData: { last_send_result: summary },
    }).catch(() => undefined);
    throw new HttpError(
      502,
      `Spreadsheet waybill upload partially failed: ${results.length} sent, ${failures.length} failed`,
    );
  }

  await markChatAttachmentStatus({
    companyId: input.companyId,
    attachmentId: attachment.id,
    status: "sent",
    mergeParsedData: { sent_result: summary },
  });

  return summary;
}

export const chatService = {
  createConversation,
  deleteConversation,
  listConversations,
  getMessages,
  sendConversationMessage,
  confirmPayrollAction,
  confirmWaybillAction,
  confirmWaybillSpreadsheetAction,
};
