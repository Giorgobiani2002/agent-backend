import path from "path";
import { readdir, readFile, stat } from "fs/promises";
import { HttpError } from "../errors";
import { GeminiService, geminiService } from "./gemini";
import { ingestBook } from "./books";
import { findBookBySourcePath } from "../repositories/books";
import { chunkStructured, splitIntoSections, type DocumentSection } from "../utils/chunking";
import { discoverPdfFiles, parsePdfFile } from "../utils/pdf";

// Shared corpus-ingestion layer used by the FINO + legislation + accounting
// scripts. Knowledge is GLOBAL (one shared brain for every company), so these
// helpers only run server-side / via npm scripts, never per request.

export type CorpusTopic =
  | "tax_law"
  | "accounting_standard"
  | "accounting_book"
  | "rs_manual"
  | "fino_template"
  | "reference";

export interface CorpusMetadataInput {
  topic: CorpusTopic;
  language?: "ka" | "en";
  version?: string;
  effectiveDate?: string;
  sourceUrl?: string;
  corpusId?: string;
  sourcePath?: string;
  source?: string;
  extra?: Record<string, unknown>;
}

/**
 * Standard metadata stamped on every corpus book. `topic` and `tags` are read
 * by the retrieval soft-boost (repositories/books.ts → searchBookChunksWithNeighbors),
 * so keeping them consistent directly improves ranking for tagged queries.
 */
export function corpusMetadata(input: CorpusMetadataInput): Record<string, unknown> {
  const tags = [input.topic, input.language, input.version]
    .filter(Boolean)
    .join(",")
    .toLowerCase();

  return {
    source: input.source ?? "corpus",
    topic: input.topic,
    language: input.language ?? "ka",
    tags,
    ...(input.version ? { version: input.version } : {}),
    ...(input.effectiveDate ? { effectiveDate: input.effectiveDate } : {}),
    ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    ...(input.corpusId ? { corpusId: input.corpusId } : {}),
    ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
    ...(input.extra ?? {}),
  };
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9Ⴀ-ჿ]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "doc"
  );
}

function headingSnippet(section: DocumentSection): string {
  const head = (section.heading || section.body).replace(/^#+\s*/, "").trim();
  return head.length > 60 ? `${head.slice(0, 57)}…` : head;
}

/** Group sections into book-sized buckets so no single book dwarfs the rest. */
function groupSections(sections: DocumentSection[], maxBookChars: number): DocumentSection[][] {
  const buckets: DocumentSection[][] = [];
  let current: DocumentSection[] = [];
  let currentLen = 0;

  for (const section of sections) {
    const len = section.body.length;
    if (current.length && currentLen + len > maxBookChars) {
      buckets.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(section);
    currentLen += len;
  }
  if (current.length) buckets.push(current);
  return buckets;
}

export interface StructuredIngestInput {
  title: string;
  text: string;
  meta: CorpusMetadataInput;
  /** A long source is split into multiple books, each at most this many chars. */
  maxBookChars?: number;
  force?: boolean;
}

export interface CorpusIngestResult {
  sourcePath: string;
  skipped: boolean;
  bookId?: string;
  parts?: number;
  error?: string;
}

/**
 * Ingest one source document. Small docs become a single book; large/structured
 * docs (a whole law) are split at chapter/article boundaries into several books
 * that share a `corpusId`, keeping each retrievable unit a sane size for the
 * RAG document-limit and anchor-window logic.
 */
export async function ingestStructuredDocument(
  input: StructuredIngestInput,
  gemini: GeminiService = geminiService,
): Promise<CorpusIngestResult[]> {
  const text = input.text.trim();
  if (!text) throw new HttpError(400, "text is required");

  const maxBookChars = input.maxBookChars ?? 60_000;
  const baseSourcePath = input.meta.sourcePath ?? `corpus:${slugify(input.title)}`;
  const corpusId = input.meta.corpusId ?? slugify(baseSourcePath);
  const sections = splitIntoSections(text);
  const buckets =
    text.length <= maxBookChars || sections.length <= 1
      ? [sections.length ? sections : [{ heading: "", body: text }]]
      : groupSections(sections, maxBookChars);

  const results: CorpusIngestResult[] = [];

  for (let i = 0; i < buckets.length; i += 1) {
    const bucket = buckets[i];
    const multi = buckets.length > 1;
    const sourcePath = multi ? `${baseSourcePath}#part-${i + 1}` : baseSourcePath;
    const title = multi
      ? `${input.title} — ნაწილი ${i + 1}/${buckets.length} (${headingSnippet(bucket[0])})`
      : input.title;

    try {
      const existing = await findBookBySourcePath(sourcePath);
      if (existing && !input.force) {
        results.push({ sourcePath, skipped: true, bookId: existing.id, parts: buckets.length });
        continue;
      }

      const bucketText = bucket.map((s) => s.body).join("\n\n");
      const book = await ingestBook(
        {
          title,
          text: bucketText,
          allowLarge: true,
          chunker: chunkStructured,
          metadata: corpusMetadata({
            ...input.meta,
            corpusId,
            sourcePath,
            extra: {
              ...(input.meta.extra ?? {}),
              ...(multi ? { part: i + 1, partOf: buckets.length } : {}),
            },
          }),
          chunkMetadata: corpusMetadata({ ...input.meta, corpusId, sourcePath }),
        },
        gemini,
      );

      results.push({ sourcePath, skipped: false, bookId: book.id, parts: buckets.length });
    } catch (error) {
      results.push({
        sourcePath,
        skipped: false,
        error: error instanceof Error ? error.message : "ingestion failed",
      });
    }
  }

  return results;
}

async function discoverTextFiles(directory: string): Promise<string[]> {
  const root = path.resolve(directory);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (
        /\.(md|txt)$/i.test(entry.name) &&
        !/^README/i.test(entry.name) &&
        !/-manifest\.(md|txt)$/i.test(entry.name) &&
        !entry.name.startsWith("_")
      ) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files.sort();
}

function titleFromPath(filePath: string): string {
  return path
    .basename(filePath)
    .replace(/\.(md|txt|pdf)$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
}

export interface CorpusFolderInput {
  directory: string;
  topic: CorpusTopic;
  language?: "ka" | "en";
  /** Include PDFs in the folder (parsed via pdf-parse). Default true. */
  includePdf?: boolean;
  force?: boolean;
}

/** Walk a drop-folder and ingest every .md/.txt/.pdf as topic-tagged corpus. */
export async function ingestCorpusFolder(
  input: CorpusFolderInput,
  gemini: GeminiService = geminiService,
): Promise<CorpusIngestResult[]> {
  const results: CorpusIngestResult[] = [];
  const textFiles = await discoverTextFiles(input.directory);
  const pdfFiles =
    input.includePdf === false ? [] : await discoverPdfFiles(input.directory).catch(() => []);

  for (const filePath of textFiles) {
    const text = await readFile(filePath, "utf8");
    const docResults = await ingestStructuredDocument(
      {
        title: titleFromPath(filePath),
        text,
        meta: {
          topic: input.topic,
          language: input.language,
          source: "markdown",
          sourcePath: filePath,
        },
        force: input.force,
      },
      gemini,
    );
    results.push(...docResults);
  }

  for (const filePath of pdfFiles) {
    try {
      const existing = await findBookBySourcePath(filePath);
      if (existing && !input.force) {
        results.push({ sourcePath: filePath, skipped: true, bookId: existing.id });
        continue;
      }
      const parsed = await parsePdfFile(filePath);
      const docResults = await ingestStructuredDocument(
        {
          title: titleFromPath(filePath),
          text: parsed.text,
          meta: {
            topic: input.topic,
            language: input.language,
            source: "pdf",
            sourcePath: filePath,
            extra: { pageCount: parsed.pages },
          },
          force: input.force,
        },
        gemini,
      );
      results.push(...docResults);
    } catch (error) {
      results.push({
        sourcePath: filePath,
        skipped: false,
        error: error instanceof Error ? error.message : "pdf ingestion failed",
      });
    }
  }

  return results;
}

export function summarize(results: CorpusIngestResult[]) {
  return {
    total: results.length,
    imported: results.filter((r) => !r.skipped && !r.error).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => r.error).length,
  };
}
