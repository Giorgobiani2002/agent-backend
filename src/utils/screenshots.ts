import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { PassThrough } from "stream";
import { uploadScreenshot } from "./s3";
import type { CaptionSegment } from "./youtube";

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

export interface ScreenshotResult {
  index: number;
  screenshotUrl: string | null;
  timestampSeconds: number;
}

async function extractFrameBuffer(videoPath: string, timestampSeconds: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const passthrough = new PassThrough();

    passthrough.on("data", (chunk: Buffer) => chunks.push(chunk));
    passthrough.on("end", () => resolve(Buffer.concat(chunks)));
    passthrough.on("error", reject);

    ffmpeg(videoPath)
      .seekInput(timestampSeconds)
      .outputOptions(["-vframes 1", "-f image2", "-vcodec mjpeg", "-q:v 2"])
      .format("image2pipe")
      .pipe(passthrough, { end: true })
      .on("error", reject);
  });
}

export async function extractScreenshots(
  videoPath: string,
  segments: CaptionSegment[],
  videoId: string,
): Promise<ScreenshotResult[]> {
  const results: ScreenshotResult[] = [];

  for (const segment of segments) {
    const midpoint = (segment.startTime + segment.endTime) / 2;
    const key = `screenshots/${videoId}/frame_${String(segment.index).padStart(4, "0")}.jpg`;

    try {
      const buffer = await extractFrameBuffer(videoPath, midpoint);
      const url = await uploadScreenshot(buffer, key, "image/jpeg");
      results.push({ index: segment.index, screenshotUrl: url, timestampSeconds: midpoint });
    } catch (error) {
      console.warn(
        `[screenshots] Failed to extract frame for segment ${segment.index} at ${midpoint}s:`,
        error instanceof Error ? error.message : error,
      );
      results.push({ index: segment.index, screenshotUrl: null, timestampSeconds: midpoint });
    }
  }

  return results;
}
