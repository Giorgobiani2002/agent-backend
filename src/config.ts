export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,

  // NOTE: keep model + dimensions in lockstep with the pgvector schema —
  // book_chunks.embedding is vector(1536) and the whole corpus is embedded
  // with gemini-embedding-2 @1536. (text-embedding-005 404s on this API key
  // and only supports 768 dims; switching models requires a column migration
  // + full re-embed of every chunk.)
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-2",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL ?? "gemini-3.5-flash",
  geminiPlaybookModel: process.env.GEMINI_PLAYBOOK_MODEL ?? "gemini-3.5-flash",
  geminiSttModel: process.env.GEMINI_STT_MODEL ?? "gemini-3.1-flash-lite-preview",
  geminiSttFallbackModel: process.env.GEMINI_STT_FALLBACK_MODEL ?? "gemini-2.5-flash",
  geminiTtsModel: process.env.GEMINI_TTS_MODEL ?? "gemini-2.5-flash-tts",
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
  /** Chunks on each side of the min–max seed span per book; included first when the full doc does not fit the char budget. */
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
  // ── Google Cloud / Vertex AI ────────────────────────────────────────────────
  /** GCP project ID linked to the $1,000 GenAI App Builder credit. */
  gcpProjectId: process.env.GCP_PROJECT_ID ?? "gen-lang-client-0730194112",
  /** Vertex AI region — global endpoint supports all latest models. */
  gcpLocation: process.env.GCP_LOCATION ?? "global",
  /** Service-account JSON for non-GCP hosts such as Railway. Local development can use ADC. */
  gcpServiceAccountJson: process.env.GCP_SERVICE_ACCOUNT_JSON,
  /** Temporary private media bucket used for Vertex video understanding. */
  gcpMediaBucket:
    process.env.GCP_MEDIA_BUCKET ??
    `declario-vertex-media-${process.env.GCP_PROJECT_ID ?? "gen-lang-client-0730194112"}`,
};
