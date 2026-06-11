import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

import { config } from "../config";
import { HttpError } from "../errors";
import { getVertexClient } from "./vertex";

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

function convertToWav(inputPath: string): Promise<string> {
    const outputPath = path.join(os.tmpdir(), `declario-stt-${randomUUID()}.wav`);

    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec("pcm_s16le")
            .audioChannels(1)
            .audioFrequency(16_000)
            .format("wav")
            .on("end", () => resolve(outputPath))
            .on("error", (error) => {
                fs.promises.unlink(outputPath).catch(() => {});
                reject(error);
            })
            .save(outputPath);
    });
}

function retryable(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /429|500|502|503|504|high demand|unavailable|resource exhausted/i.test(message);
}

async function transcribeAudio(audioData: Buffer) {
    const models = [...new Set([
        config.geminiSttModel,
        config.geminiSttFallbackModel,
    ].filter(Boolean))];
    let lastError: unknown;

    for (const model of models) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await getVertexClient().models.generateContent({
                    model,
                    contents: [{
                        role: "user",
                        parts: [
                            {
                                inlineData: {
                                    mimeType: "audio/wav",
                                    data: audioData.toString("base64"),
                                },
                            },
                            {
                                text: [
                                    "Transcribe this audio accurately.",
                                    "Return only the spoken words, with no commentary or markdown.",
                                    "Preserve the original language. The speaker will usually use Georgian, English, or Russian.",
                                ].join(" "),
                            },
                        ],
                    }],
                    config: {
                        temperature: 0,
                        maxOutputTokens: 2048,
                    },
                });

                const transcription = response.text?.trim();
                if (!transcription) {
                    throw new HttpError(422, "Gemini returned an empty transcription");
                }
                return transcription;
            } catch (error) {
                lastError = error;
                if (!retryable(error) || attempt === 1) break;
                await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
            }
        }
    }

    throw lastError ?? new Error("No speech transcription model is configured");
}

/**
 * Transcribes short browser recordings through Vertex AI Gemini.
 * Browser formats are normalized to mono 16 kHz WAV before upload.
 */
export class SttService {
    async transcribe(audioPath: string): Promise<string> {
        let wavPath: string | null = null;

        try {
            wavPath = await convertToWav(audioPath);
            const audioData = await fs.promises.readFile(wavPath);
            return await transcribeAudio(audioData);
        } catch (error: unknown) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(
                500,
                `Speech transcription failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            if (wavPath) await fs.promises.unlink(wavPath).catch(() => {});
        }
    }
}

export const sttService = new SttService();
