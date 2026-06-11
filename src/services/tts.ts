import { config } from "../config";
import { HttpError } from "../errors";
import { getVertexClient } from "./vertex";

function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1, bitsPerSample = 16) {
    if (pcm.length >= 12 && pcm.toString("ascii", 0, 4) === "RIFF") return pcm;

    const header = Buffer.alloc(44);
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;

    header.write("RIFF", 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write("data", 36);
    header.writeUInt32LE(pcm.length, 40);

    return Buffer.concat([header, pcm]);
}

/**
 * Synthesizes speech through Vertex AI Gemini and returns WAV audio.
 */
export class TtsService {
    async synthesize(text: string): Promise<Buffer> {
        try {
            const response = await getVertexClient().models.generateContent({
                model: config.geminiTtsModel,
                contents: [{
                    role: "user",
                    parts: [{
                        text: `[warm, conversational, responsive, natural pace, subtle variation, no announcer tone] ${text}`,
                    }],
                }],
                config: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: config.geminiTtsVoice,
                            },
                        },
                    },
                },
            });

            const data = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (!data) {
                throw new HttpError(502, "Gemini TTS returned no audio content");
            }

            return pcmToWav(Buffer.from(data, "base64"));
        } catch (error: unknown) {
            if (error instanceof HttpError) throw error;
            throw new HttpError(
                500,
                `Speech synthesis failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
}

export const ttsService = new TtsService();
