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

export function formatDocumentForEmbedding(title: string, content: string): string {
  return `title: ${title || "none"} | text: ${content}`;
}

export function formatQueryForEmbedding(content: string): string {
  return `task: question answering | query: ${content}`;
}

