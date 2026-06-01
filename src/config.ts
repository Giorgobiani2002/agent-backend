export const config = {
  geminiApiKey: process.env.GEMINI_API_KEY,
  cartesiaApiKey: process.env.CARTESIA_API_KEY,
  openaiApiKey: process.env.OPENAI_API_KEY,
  geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL ?? "gemini-embedding-2",
  geminiChatModel: process.env.GEMINI_CHAT_MODEL ?? "gemini-3.1-flash-lite-preview",
  geminiPlaybookModel: process.env.GEMINI_PLAYBOOK_MODEL ?? "gemini-3.1-flash-lite-preview",
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
};

