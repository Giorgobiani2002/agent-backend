import { config } from "../config";
import { HttpError } from "../errors";

/**
 * Service for Text-to-Speech conversion using Cartesia.ai.
 */
export class TtsService {
    /**
     * Converts text to speech audio.
     * @param text The text to convert.
     * @returns Audio data as a Buffer.
     */
    async synthesize(text: string): Promise<Buffer> {
        if (!config.cartesiaApiKey) {
            throw new HttpError(500, "Cartesia API key is not configured");
        }

        try {
            const response = await fetch("https://api.cartesia.ai/tts/bytes", {
                method: "POST",
                headers: {
                    "X-API-Key": config.cartesiaApiKey,
                    "Cartesia-Version": "2024-06-10",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    model_id: "sonic-multilingual",
                    transcript: text,
                    voice: {
                        mode: "id",
                        id: "794f9389-aac1-45b6-b726-9d9369183238", // Baritone voice, usually good for Georgian
                    },
                    output_format: {
                        container: "wav",
                        sample_rate: 24000,
                        encoding: "pcm_f32le",
                    },
                    language: "ka", // Georgian
                }),
            });

            if (!response.ok) {
                const error = (await response.json()) as any;
                throw new HttpError(
                    response.status,
                    `Cartesia synthesis failed: ${error.message || response.statusText}`,
                );
            }

            const arrayBuffer = await response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        } catch (error: any) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(500, `TTS synthesis error: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

export const ttsService = new TtsService();
