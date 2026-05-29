import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { YoutubeTranscript } from "youtube-transcript";
import { HttpError } from "../errors";

const execFileAsync = promisify(execFile);

// On Railway: install yt-dlp via `pip install yt-dlp` in your build command.
// Locally: pip3 install yt-dlp
const YT_DLP_BIN = process.env.YT_DLP_BIN ?? "yt-dlp";

export interface CaptionSegment {
  text: string;
  startTime: number;
  endTime: number;
  index: number;
}

export interface VideoDownloadResult {
  videoPath: string;
  videoId: string;
  title: string;
  duration: number;
  cleanup: () => Promise<void>;
}

export function extractVideoId(url: string): string {
  try {
    const parsed = new URL(url);
    // youtu.be/<id>
    if (parsed.hostname === "youtu.be") {
      const id = parsed.pathname.slice(1).split("/")[0];
      if (id) return id;
    }
    // youtube.com/watch?v=<id>
    const v = parsed.searchParams.get("v");
    if (v) return v;
    // youtube.com/embed/<id> or /shorts/<id>
    const match = parsed.pathname.match(/\/(embed|shorts|v)\/([^/?&]+)/);
    if (match) return match[2];
  } catch {
    // fall through to error
  }
  throw new HttpError(400, "Invalid YouTube URL");
}

export async function fetchCaptions(videoId: string): Promise<CaptionSegment[]> {
  let raw;
  try {
    raw = await YoutubeTranscript.fetchTranscript(videoId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(422, `Video has no available captions: ${message}`);
  }

  if (!raw || raw.length === 0) {
    throw new HttpError(422, "Video has no available captions");
  }

  return raw.map((item, i) => ({
    text: item.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    startTime: item.offset / 1000,
    endTime: (item.offset + item.duration) / 1000,
    index: i,
  }));
}

export async function downloadVideo(videoId: string): Promise<VideoDownloadResult> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const videoPath = path.join(os.tmpdir(), `ytdl-${videoId}-${Date.now()}.mp4`);

  // Get video metadata (title, duration)
  let title = videoId;
  let duration = 0;
  try {
    const { stdout } = await execFileAsync(
      YT_DLP_BIN,
      ["--dump-json", "--no-playlist", "--no-warnings", url],
      { maxBuffer: 5 * 1024 * 1024 },
    );
    const info = JSON.parse(stdout.trim());
    title = info.title ?? videoId;
    duration = Number(info.duration) || 0;
  } catch {
    // Non-fatal: proceed with defaults if metadata fetch fails
  }

  // Download video-only stream at ≤720p (audio not needed for screenshots)
  try {
    await execFileAsync(
      YT_DLP_BIN,
      [
        "-f",
        "bestvideo[ext=mp4][height<=720]/bestvideo[height<=720]/bestvideo[ext=mp4]/bestvideo/best[ext=mp4]/best",
        "-o",
        videoPath,
        "--no-playlist",
        "--no-warnings",
        url,
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 10 * 60 * 1000, // 10 minutes
      },
    );
  } catch (error: unknown) {
    // Clean up any partial file
    await fs.promises.unlink(videoPath).catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, `Video download failed: ${message}`);
  }

  const cleanup = async () => {
    try {
      await fs.promises.unlink(videoPath);
    } catch {
      // best-effort cleanup
    }
  };

  return { videoPath, videoId, title, duration, cleanup };
}
