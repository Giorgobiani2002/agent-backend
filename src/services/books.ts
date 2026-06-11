import { HttpError } from "../errors";
import fs from "fs/promises";
import {
  createBookWithChunks,
  createFailedBook,
  deleteBook,
  findBookBySourcePath,
  getBook,
  getBookWithChunks,
  listBooks,
  listBooksWithFilters,
  replaceBookContent,
} from "../repositories/books";
import { GeminiService, geminiService } from "./gemini";
import { chunkText, formatDocumentForEmbedding, type TextChunk } from "../utils/chunking";
import {
  defaultDataDirectory,
  discoverPdfFiles,
  parsePdfFile,
  titleFromPdfPath,
} from "../utils/pdf";
import { assertApprovedKnowledgeMetadata } from "./corpus-sources";

// Knowledge is GLOBAL across all companies — only platform admins seed it.
// The chat brain (RAG over books/book_chunks) gives every company the same
// accounting + finance knowledge.

interface TranscriptRecord {
  id: string;
  title: string;
  url: string;
  source_id?: string | null;
  transcript: string;
  char_count?: number;
  transcript_source?: string;
}

const MAX_MANUAL_TEXT_LENGTH = 200_000;

function ensureTextWithinLimit(text: string): void {
  if (text.length > MAX_MANUAL_TEXT_LENGTH) {
    throw new HttpError(400, `text must be at most ${MAX_MANUAL_TEXT_LENGTH} characters`);
  }
}

function isEditableBookMetadata(metadata: Record<string, unknown>): boolean {
  return metadata.source === "api";
}

function manualBookMetadata(
  metadata: Record<string, unknown>,
  rawText: string,
): Record<string, unknown> {
  return {
    ...metadata,
    source: "api",
    rawText,
    rightsStatus: metadata.rightsStatus ?? "pending",
  };
}

export async function ingestBook(
  input: {
    title: string;
    author?: string;
    text: string;
    metadata: Record<string, unknown>;
    chunkMetadata?: Record<string, unknown>;
    // File/legal/FINO ingestion is server-trusted and may exceed the 200K cap
    // that protects the manual paste UI — set this to skip the length guard.
    allowLarge?: boolean;
    // Lets callers pick a structure-aware chunker (e.g. chunkStructured for
    // legislation) instead of the default prose chunker.
    chunker?: (text: string) => TextChunk[];
  },
  gemini: GeminiService = geminiService,
) {
  const title = input.title.trim();
  const text = input.text.trim();

  if (!title) {
    throw new HttpError(400, "title is required");
  }

  if (!text) {
    throw new HttpError(400, "text is required");
  }

  if (!input.allowLarge) {
    ensureTextWithinLimit(text);
  }

  const chunks = (input.chunker ?? chunkText)(text);

  if (!chunks.length) {
    throw new HttpError(400, "text did not produce any chunks");
  }

  try {
    const embeddedChunks = [];

    for (const chunk of chunks) {
      const embedding = await gemini.embed(formatDocumentForEmbedding(title, chunk.content));
      embeddedChunks.push({
        chunkIndex: chunk.index,
        content: chunk.content,
        tokenCount: chunk.tokenCount,
        charCount: chunk.charCount,
        metadata: input.chunkMetadata ?? { source: "api" },
        embedding,
      });
    }

    return createBookWithChunks({
      title,
      author: input.author?.trim() || undefined,
      metadata: input.metadata,
      chunks: embeddedChunks,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    await createFailedBook({
      title,
      author: input.author?.trim() || undefined,
      metadata: input.metadata,
      error: error instanceof Error ? error.message : "Book ingestion failed",
    });

    throw error;
  }
}

export async function ingestPdfBook(
  input: {
    filePath: string;
    title?: string;
    author?: string;
    metadata?: Record<string, unknown>;
    force?: boolean;
  },
  gemini: GeminiService = geminiService,
) {
  const sourcePath = input.filePath;
  const existing = await findBookBySourcePath(sourcePath);

  if (existing && !input.force) {
    return {
      book: existing,
      skipped: true,
      sourcePath,
    };
  }

  const parsed = await parsePdfFile(sourcePath);
  const title = input.title?.trim() || titleFromPdfPath(sourcePath);
  const author =
    input.author?.trim() ||
    (typeof parsed.info.Author === "string" ? parsed.info.Author : undefined);

  const book = await ingestBook(
    {
      title,
      author,
      text: parsed.text,
      metadata: {
        ...(input.metadata ?? {}),
        source: "pdf",
        sourcePath,
        pageCount: parsed.pages,
        pdfInfo: parsed.info,
      },
      chunkMetadata: {
        source: "pdf",
        sourcePath,
      },
    },
    gemini,
  );

  return {
    book,
    skipped: false,
    sourcePath,
  };
}

export async function createManualBook(
  input: {
    title: string;
    author?: string;
    text: string;
    metadata?: Record<string, unknown>;
  },
  gemini: GeminiService = geminiService,
) {
  const text = input.text.trim();
  const metadata = manualBookMetadata(input.metadata ?? {}, text);
  if (metadata.rightsStatus === "approved") {
    assertApprovedKnowledgeMetadata(metadata);
  }

  return ingestBook(
    {
      title: input.title,
      author: input.author,
      text,
      metadata,
      chunkMetadata: {
        source: "api",
        rightsStatus: metadata.rightsStatus,
        license: metadata.license,
        attribution: metadata.attribution,
        sourceUrl: metadata.sourceUrl,
      },
    },
    gemini,
  );
}

export async function ingestPdfDirectory(
  input: {
    directory?: string;
    force?: boolean;
  } = {},
  gemini: GeminiService = geminiService,
) {
  const directory = input.directory ?? defaultDataDirectory();
  const files = await discoverPdfFiles(directory);
  const results = [];

  for (const filePath of files) {
    try {
      results.push(await ingestPdfBook({ filePath, force: input.force }, gemini));
    } catch (error) {
      results.push({
        sourcePath: filePath,
        skipped: false,
        error: error instanceof Error ? error.message : "PDF ingestion failed",
      });
    }
  }

  return {
    directory,
    total: files.length,
    imported: results.filter((result) => "book" in result && !result.skipped).length,
    skipped: results.filter((result) => "book" in result && result.skipped).length,
    failed: results.filter((result) => "error" in result).length,
    results,
  };
}

export async function ingestTranscript(
  input: {
    transcript: TranscriptRecord;
    sourceFile?: string;
    force?: boolean;
  },
  gemini: GeminiService = geminiService,
) {
  const sourcePath = `youtube:${input.transcript.id}`;
  const existing = await findBookBySourcePath(sourcePath);

  if (existing && !input.force) {
    return {
      book: existing,
      skipped: true,
      sourcePath,
    };
  }

  const book = await ingestBook(
    {
      title: input.transcript.title,
      text: input.transcript.transcript,
      metadata: {
        source: "youtube_transcript",
        sourcePath,
        sourceFile: input.sourceFile,
        videoId: input.transcript.id,
        url: input.transcript.url,
        notebookSourceId: input.transcript.source_id ?? undefined,
        transcriptSource: input.transcript.transcript_source ?? "notebooklm_fulltext",
        transcriptCharCount:
          input.transcript.char_count ?? input.transcript.transcript.length,
      },
      chunkMetadata: {
        source: "youtube_transcript",
        sourcePath,
        videoId: input.transcript.id,
        url: input.transcript.url,
      },
    },
    gemini,
  );

  return {
    book,
    skipped: false,
    sourcePath,
  };
}

export async function ingestTranscriptJsonFile(
  input: {
    filePath: string;
    force?: boolean;
  },
  gemini: GeminiService = geminiService,
) {
  const filePath = input.filePath;
  const raw = await fs.readFile(filePath, "utf8");
  const transcripts = JSON.parse(raw) as TranscriptRecord[];

  if (!Array.isArray(transcripts)) {
    throw new HttpError(400, "transcript JSON must be an array");
  }

  const results = [];

  for (const transcript of transcripts) {
    try {
      results.push(
        await ingestTranscript(
          {
            transcript,
            sourceFile: filePath,
            force: input.force,
          },
          gemini,
        ),
      );
    } catch (error) {
      results.push({
        sourcePath: transcript?.id ? `youtube:${transcript.id}` : filePath,
        skipped: false,
        error: error instanceof Error ? error.message : "Transcript ingestion failed",
      });
    }
  }

  return {
    filePath,
    total: transcripts.length,
    imported: results.filter((result) => "book" in result && !result.skipped).length,
    skipped: results.filter((result) => "book" in result && result.skipped).length,
    failed: results.filter((result) => "error" in result).length,
    results,
  };
}

export async function listKnowledgeBooks() {
  return listBooksWithFilters();
}

export async function getKnowledgeBook(id: string) {
  return getBookWithChunks(id);
}

export async function updateManualBook(
  input: {
    id: string;
    title: string;
    author?: string;
    text: string;
    metadata?: Record<string, unknown>;
  },
  gemini: GeminiService = geminiService,
) {
  const existing = await getBook(input.id);

  if (!existing) {
    throw new HttpError(404, "Book not found");
  }

  if (!isEditableBookMetadata(existing.metadata)) {
    throw new HttpError(409, "Only manual text knowledge can be edited");
  }

  const title = input.title.trim();
  const text = input.text.trim();

  if (!title) {
    throw new HttpError(400, "title is required");
  }

  if (!text) {
    throw new HttpError(400, "text is required");
  }

  ensureTextWithinLimit(text);

  const chunks = chunkText(text);

  if (!chunks.length) {
    throw new HttpError(400, "text did not produce any chunks");
  }

  const mergedMetadata = manualBookMetadata(
    {
      ...existing.metadata,
      ...(input.metadata ?? {}),
      updatedBy: "knowledge_board",
      updatedAt: new Date().toISOString(),
    },
    text,
  );

  const embeddedChunks = [];
  for (const chunk of chunks) {
    const embedding = await gemini.embed(formatDocumentForEmbedding(title, chunk.content));
    embeddedChunks.push({
      chunkIndex: chunk.index,
      content: chunk.content,
      tokenCount: chunk.tokenCount,
      charCount: chunk.charCount,
      metadata: { source: "api" },
      embedding,
    });
  }

  const updated = await replaceBookContent({
    id: input.id,
    title,
    author: input.author?.trim() || undefined,
    metadata: mergedMetadata,
    chunks: embeddedChunks,
  });

  if (!updated) {
    throw new HttpError(404, "Book not found");
  }

  return updated;
}

export async function deleteKnowledgeBook(id: string) {
  const deleted = await deleteBook(id);

  if (!deleted) {
    throw new HttpError(404, "Book not found");
  }
}

export const booksService = {
  createManualBook,
  deleteKnowledgeBook,
  getKnowledgeBook,
  getBook,
  ingestBook,
  ingestPdfBook,
  ingestPdfDirectory,
  ingestTranscript,
  ingestTranscriptJsonFile,
  listKnowledgeBooks,
  listBooks,
  updateManualBook,
};
