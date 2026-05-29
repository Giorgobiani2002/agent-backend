import {
  chunkText,
  formatDocumentForEmbedding,
  formatQueryForEmbedding,
} from "./chunking";

describe("chunking utilities", () => {
  it("chunks text deterministically with indexes and counts", () => {
    const chunks = chunkText("One two three. Four five six. Seven eight nine.", 20, 5);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].index).toBe(0);
    expect(chunks[0].charCount).toBe(chunks[0].content.length);
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });

  it("formats Gemini Embedding 2 document and query prompts", () => {
    expect(formatDocumentForEmbedding("Book", "Some text")).toBe(
      "title: Book | text: Some text",
    );
    expect(formatQueryForEmbedding("What happened?")).toBe(
      "task: question answering | query: What happened?",
    );
  });
});

