export interface TextChunk {
  index: number;
  content: string;
  charCount: number;
  tokenCount: number;
}

const DEFAULT_CHUNK_SIZE = 3000;
const DEFAULT_OVERLAP = 300;

export function estimateTokenCount(text: string): number {
  return Math.ceil(text.trim().split(/\s+/).filter(Boolean).length * 1.33);
}

export function chunkText(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): TextChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  if (!normalized) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < normalized.length) {
    const hardEnd = Math.min(start + chunkSize, normalized.length);
    let end = hardEnd;

    if (hardEnd < normalized.length) {
      const boundary = Math.max(
        normalized.lastIndexOf("\n\n", hardEnd),
        normalized.lastIndexOf(". ", hardEnd),
        normalized.lastIndexOf("! ", hardEnd),
        normalized.lastIndexOf("? ", hardEnd),
        normalized.lastIndexOf(" ", hardEnd),
      );

      if (boundary > start + chunkSize * 0.5) {
        end = boundary + 1;
      }
    }

    const content = normalized.slice(start, end).trim();

    if (content) {
      chunks.push({
        index: chunks.length,
        content,
        charCount: content.length,
        tokenCount: estimateTokenCount(content),
      });
    }

    if (end >= normalized.length) {
      break;
    }

    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

// Structural boundaries for Georgian legislation, standards and markdown.
// A line that opens one of these starts a new logical section, so a single
// chunk never spans two articles/headings — which keeps retrieval precise.
//   მუხლი N  = Article,  თავი/კარი/ნაწილი = Chapter/Book/Part,  დანართი = Annex
const SECTION_BOUNDARY =
  /^(?:#{1,6}\s+|მუხლი\s+\d+|თავი\s+[IVXLCDM\d]+|კარი\s+[IVXLCDM\d]+|ნაწილი\s+[IVXLCDM\d]+|დანართი\b|Article\s+\d+|Chapter\s+\d+)/u;

export interface DocumentSection {
  heading: string;
  body: string;
}

/** Split a document into logical sections at legal/heading boundaries. */
export function splitIntoSections(text: string): DocumentSection[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: DocumentSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    if (SECTION_BOUNDARY.test(line.trim())) {
      if (current) {
        sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
      }
      current = { heading: line.trim(), lines: [line] };
    } else {
      if (!current) current = { heading: "", lines: [] };
      current.lines.push(line);
    }
  }

  if (current) {
    sections.push({ heading: current.heading, body: current.lines.join("\n").trim() });
  }

  return sections.filter((section) => section.body);
}

/**
 * Like chunkText, but first splits on structural boundaries so no chunk
 * crosses an article/heading. Falls back to plain chunkText for unstructured
 * prose (single section). The leading heading line stays with its section so
 * each chunk carries its own context (e.g. "მუხლი 47 ...").
 */
export function chunkStructured(
  text: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
  overlap = DEFAULT_OVERLAP,
): TextChunk[] {
  const sections = splitIntoSections(text);

  if (sections.length <= 1) {
    return chunkText(text, chunkSize, overlap);
  }

  const chunks: TextChunk[] = [];
  for (const section of sections) {
    for (const sub of chunkText(section.body, chunkSize, overlap)) {
      chunks.push({
        index: chunks.length,
        content: sub.content,
        charCount: sub.charCount,
        tokenCount: sub.tokenCount,
      });
    }
  }

  return chunks;
}

export function formatDocumentForEmbedding(title: string, content: string): string {
  return `title: ${title || "none"} | text: ${content}`;
}

export function formatQueryForEmbedding(content: string): string {
  return `task: question answering | query: ${content}`;
}

