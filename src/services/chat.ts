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

function clipChunkPreviewForMetadata(content: string, maxChars: number): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxChars - 1))}…`;
}

function chunkSourceUrl(metadata: Record<string, unknown>): string | undefined {
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
  const url = typeof metadata.url === "string" ? metadata.url : undefined;
  const videoId =
    typeof metadata.videoId === "string" ? metadata.videoId : undefined;
  const sourcePath =
    typeof metadata.sourcePath === "string" ? metadata.sourcePath : undefined;

  if (source) parts.push(`source=${source}`);
  if (videoId) parts.push(`videoId=${videoId}`);
  if (url) parts.push(`url=${url}`);
  if (!videoId && !url && sourcePath) parts.push(`sourcePath=${sourcePath}`);

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
      parts: [{ text: contextPrompt }],
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

async function runToolLoop(
  gemini: GeminiService,
  systemInstruction: string,
  initialContents: Content[],
  ctx: { companyId: string; userId?: string },
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
    // call alongside our response (Gemini requires this pairing).
    contents.push({
      role: "model",
      parts: turn.functionCalls.map((call: FunctionCall) => ({
        functionCall: { name: call.name ?? "", args: call.args ?? {} },
      })),
    });

    const responseParts = await Promise.all(
      turn.functionCalls.map(async (call: FunctionCall) => {
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

  // Per-company per-hour rate limit. Throws 429 when over cap; the
  // bump itself IS the check, so two concurrent requests can't race
  // past the limit. Set CHAT_MAX_MSGS_PER_HOUR=0 to disable.
  await checkAndBumpChatLimit(input.companyId);

  const history = await getRecentMessages(input.conversationId);
  const diagnosticMode = looksLikeDiagnosticQuery(content);

  // Diagnostic queries skip the RAG embed: the answer lives in live data,
  // not the book corpus, and the embed call is the slowest single step.
  let context: ComprehensiveContext = emptyContext();
  if (!diagnosticMode) {
    let queryEmbedding: number[];
    try {
      queryEmbedding = await gemini.embed(formatQueryForEmbedding(content));
    } catch (error) {
      console.error("[chat] Gemini embed failed:", error);
      throw new HttpError(
        502,
        `Gemini embed failed: ${getUpstreamErrorMessage(error)}`,
      );
    }
    context = await gatherComprehensiveContext(queryEmbedding);
  }

  let assistant: { text: string; model: string };
  let toolTrace: ChatToolTraceEntry[] = [];
  let toolIterations = 0;
  try {
    const baseMessages = buildGeminiMessages({ history, context, content });
    const toolLoopResult = await runToolLoop(
      gemini,
      chatToolSystemInstruction(),
      baseMessages,
      { companyId: input.companyId, userId: input.userId },
    );
    assistant = { text: toolLoopResult.text, model: toolLoopResult.model };
    toolTrace = toolLoopResult.trace;
    toolIterations = toolLoopResult.iterations;
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

export const chatService = {
  createConversation,
  deleteConversation,
  listConversations,
  getMessages,
  sendConversationMessage,
};
