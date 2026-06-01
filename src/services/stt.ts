import fs from "fs";
import { config } from "../config";
import { HttpError } from "../errors";

/**
 * Service for Speech-to-Text conversion using OpenAI Whisper.
 */
export class SttService {
    /**
     * Transcribes an audio file to text.
     * @param audioPath Path to the audio file.
     * @returns Transcribed text.
     */
    async transcribe(audioPath: string): Promise<string> {
        if (!config.openaiApiKey) {
            throw new HttpError(500, "OpenAI API key is not configured");
        }

        const formData = new FormData();
        formData.append("file", new Blob([fs.readFileSync(audioPath)]), "audio.webm");
        formData.append("model", "whisper-1");
        formData.append("language", "ka"); // Georgian

        try {
            const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${config.openaiApiKey}`,
                },
                body: formData,
            });

            if (!response.ok) {
                const error = (await response.json()) as any;
                throw new HttpError(
                    response.status,
                    `OpenAI transcription failed: ${error.error?.message || response.statusText}`,
                );
            }

            const data = (await response.json()) as { text: string };
            return data.text;
        } catch (error: any) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(500, `Transcription error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export const sttService = new SttService();
