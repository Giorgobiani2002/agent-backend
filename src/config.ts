const GEMINI_VERTEX_EMBEDDING_MODEL = "gemini-embedding-2";

const LEGACY_VERTEX_EMBEDDING_MODELS: Record<string, string> = {
  // Keep the vector space stable for the existing vector(1536) corpus.
  "text-embedding-005": GEMINI_VERTEX_EMBEDDING_MODEL,
};

export function resolveGeminiEmbeddingModel(rawModel = process.env.GEMINI_EMBEDDING_MODEL): string {
  const trimmed = rawModel?.trim();
  if (!trimmed) return GEMINI_VERTEX_EMBEDDING_MODEL;

  const modelResourceMatch = trimmed.match(/(?:^|\/)models\/([^/]+)$/);
  const modelName = modelResourceMatch?.[1] ?? trimmed.replace(/^models\//, "");
  return LEGACY_VERTEX_EMBEDDING_MODELS[modelName] ?? modelName;
}

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,

  // All Gemini-family model calls route through Vertex AI / Gemini Enterprise.
  // Configure auth with GCP_PROJECT_ID, GCP_LOCATION, and either ADC or
  // GCP_SERVICE_ACCOUNT_JSON. AI Studio GEMINI_API_KEY is intentionally unused.

  // NOTE: keep model + dimensions in lockstep with the pgvector schema.
  // book_chunks.embedding is vector(1536) and the whole corpus is embedded
  // with gemini-embedding-2 @1536. Keep this model stable unless the corpus is
  // re-embedded in the same vector space.
  geminiEmbeddingModel: resolveGeminiEmbeddingModel(),
  geminiChatModel: process.env.GEMINI_CHAT_MODEL ?? "gemini-3.5-flash",
  geminiPlaybookModel: process.env.GEMINI_PLAYBOOK_MODEL ?? "gemini-3.5-flash",
  geminiSttModel: process.env.GEMINI_STT_MODEL ?? "gemini-3.1-flash-lite-preview",
  geminiSttFallbackModel: process.env.GEMINI_STT_FALLBACK_MODEL ?? "gemini-2.5-flash",
  // Vertex TTS model returns PCM s16le @24kHz mono -> pcmToWav.
  geminiTtsModel: process.env.GEMINI_TTS_MODEL ?? "gemini-3.1-flash-tts-preview",
  geminiTtsVoice: process.env.GEMINI_TTS_VOICE ?? "Kore",
  geminiEmbeddingDimensions: Number(process.env.GEMINI_EMBEDDING_DIMENSIONS ?? 1536),
  geminiChatMaxOutputTokens: Number(process.env.GEMINI_CHAT_MAX_OUTPUT_TOKENS ?? 8192),
  geminiChatTemperature: Number(process.env.GEMINI_CHAT_TEMPERATURE ?? 0.55),
  ragTopK: Number(process.env.RAG_TOP_K ?? 12),
  ragNeighborWindow: Number(process.env.RAG_NEIGHBOR_WINDOW ?? 1),
  ragMaxContextChunks: Number(process.env.RAG_MAX_CONTEXT_CHUNKS ?? 36),
  ragDocumentLimit: Number(process.env.RAG_DOCUMENT_LIMIT ?? 5),
  ragMaxContextChars: Number(process.env.RAG_MAX_CONTEXT_CHARS ?? 140000),
  /** Final assembled context prompt cap (instructions + sources); avoids oversized Gemini requests. */
  ragPromptCharHardCap: Number(process.env.RAG_PROMPT_CHAR_HARD_CAP ?? 155000),
  /** Chunks on each side of the min-max seed span per book; included first when the full doc does not fit the char budget. */
  ragChunkAnchorWindow: Number(process.env.RAG_CHUNK_ANCHOR_WINDOW ?? 40),
  ragIncludeModelKnowledge: process.env.RAG_INCLUDE_MODEL_KNOWLEDGE !== "false",
  /** rs-server base URL for the internal-tools surface used by chat tool-calling. */
  rsServerUrl: (process.env.RS_SERVER_URL ?? "http://localhost:3000/api/v1").replace(/\/$/, ""),
  /** Shared secret with rs-server's InternalSecretGuard. Required for chat tools. */
  aiInternalSecret: process.env.AI_INTERNAL_SECRET ?? "",
  /** Hard cap on chat tool-call loop iterations to bound cost + latency. */
  chatToolMaxIterations: Number(process.env.CHAT_TOOL_MAX_ITERATIONS ?? 5),
  s3Endpoint: process.env.S3_ENDPOINT ?? "https://t3.storageapi.dev",
  s3Region: process.env.S3_REGION ?? "auto",
  s3Bucket: process.env.S3_BUCKET ?? "",
  s3AccessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
  s3SecretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  // Google Cloud / Vertex AI
  /** GCP project ID linked to the credit-backed billing account. */
  gcpProjectId: process.env.GCP_PROJECT_ID ?? "gen-lang-client-0734367816",
  /** Vertex AI region; global endpoint supports the latest Gemini models. */
  gcpLocation: process.env.GCP_LOCATION ?? "global",
  /** Service-account JSON for non-GCP hosts such as Railway. Local development can use ADC. */
  gcpServiceAccountJson: process.env.GCP_SERVICE_ACCOUNT_JSON,
  /** Temporary private media bucket used for Vertex video understanding. */
  gcpMediaBucket:
    process.env.GCP_MEDIA_BUCKET ??
    `declario-vertex-media-${process.env.GCP_PROJECT_ID ?? "gen-lang-client-0734367816"}`,
};
