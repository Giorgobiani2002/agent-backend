import { HttpError } from "../errors";
import {
  createBookWithChunks,
  createFailedBook,
  findBookBySourcePath,
  type BookRow,
} from "../repositories/books";
import { GeminiService, geminiService } from "./gemini";
import { estimateTokenCount, formatDocumentForEmbedding } from "../utils/chunking";
import { extractVideoId, fetchCaptions, downloadVideo, type VideoDownloadResult } from "../utils/youtube";
import { extractScreenshots } from "../utils/screenshots";

export interface IngestVideoInput {
  // Knowledge from videos is global. No companyId here on purpose.
  url: string;
  force?: boolean;
}

export interface IngestVideoResult {
  book: BookRow;
  skipped: boolean;
  sourcePath: string;
}

export async function ingestVideo(
  input: IngestVideoInput,
  gemini: GeminiService = geminiService,
): Promise<IngestVideoResult> {
  const videoId = extractVideoId(input.url);
  const sourcePath = `youtube_video:${videoId}`;

  const existing = await findBookBySourcePath(sourcePath);
  if (existing && !input.force) {
    return { book: existing, skipped: true, sourcePath };
  }

  // Fetch captions and download video in parallel
  const [segments, videoDownload] = await Promise.all([
    fetchCaptions(videoId),
    downloadVideo(videoId),
  ]);

  const { title, duration } = videoDownload;
  const bookMetadata: Record<string, unknown> = {
    source: "youtube_video",
    sourcePath,
    videoId,
    url: input.url,
    duration,
  };

  let download: VideoDownloadResult | null = videoDownload;

  try {
    const screenshots = await extractScreenshots(videoDownload.videoPath, segments, videoId);

    // Temp video no longer needed after screenshots are extracted
    await videoDownload.cleanup();
    download = null;

    const embeddedChunks = [];
    for (const segment of segments) {
      const embedding = await gemini.embed(formatDocumentForEmbedding(title, segment.text));
      const screenshotUrl = screenshots[segment.index]?.screenshotUrl ?? null;

      embeddedChunks.push({
        chunkIndex: segment.index,
        content: segment.text,
        tokenCount: estimateTokenCount(segment.text),
        charCount: segment.text.length,
        metadata: {
          source: "youtube_video",
          videoId,
          startTime: segment.startTime,
          endTime: segment.endTime,
          screenshotUrl,
        },
        embedding,
      });
    }

    const book = await createBookWithChunks({
      title,
      metadata: bookMetadata,
      chunks: embeddedChunks,
    });

    return { book, skipped: false, sourcePath };
  } catch (error) {
    if (download) {
      await download.cleanup();
    }

    if (error instanceof HttpError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    await createFailedBook({ title, metadata: bookMetadata, error: message }).catch(() => {});
    throw error;
  }
}

export const videoService = { ingestVideo };
