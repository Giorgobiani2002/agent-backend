import { sendConversationMessage } from "./chat";
import { GeminiService } from "./gemini";
import * as chatRepository from "../repositories/chat";
import * as booksRepository from "../repositories/books";
import * as rateLimit from "./chat-rate-limit";
import { TEST_COMPANY_ID } from "../test-utils";

jest.mock("../repositories/chat");
jest.mock("../repositories/books");
jest.mock("./chat-rate-limit");

describe("chat service", () => {
  const gemini: GeminiService = {
    embed: jest.fn(async () => new Array(1536).fill(0.2)),
    generateChatResponse: jest.fn(async () => ({
      text: "Assistant answer",
      model: "gemini-3.1-flash-lite-preview",
    })),
    generateStructured: jest.fn(),
    generateWithTools: jest.fn(async () => ({
      functionCalls: [],
      text: "Assistant answer",
      model: "gemini-3.1-flash-lite-preview",
    })),
    validateData: jest.fn(async () => []),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(rateLimit.checkAndBumpChatLimit).mockResolvedValue({ count: 1, limit: 60 });
    jest.mocked(chatRepository.getConversation).mockResolvedValue({
      id: "conversation-1",
      user_id: "user-1",
      company_id: TEST_COMPANY_ID,
      title: null,
      metadata: {},
      created_at: "now",
      updated_at: "now",
    });
    jest.mocked(chatRepository.getRecentMessages).mockResolvedValue([]);
    jest.mocked(booksRepository.searchBookChunks).mockResolvedValue([
      {
        id: "chunk-1",
        book_id: "book-1",
        chunk_index: 0,
        content: "Relevant book text",
        token_count: 3,
        char_count: 18,
        metadata: {
          source: "youtube_transcript",
          url: "https://www.youtube.com/watch?v=abc",
        },
        rank: 1,
        similarity: 0.9,
      },
    ]);
    jest.mocked(booksRepository.loadChunksForBooks).mockResolvedValue([
      {
        id: "chunk-1",
        book_id: "book-1",
        chunk_index: 0,
        content: "Relevant book text",
        token_count: 3,
        char_count: 18,
        metadata: {
          source: "youtube_transcript",
          url: "https://www.youtube.com/watch?v=abc",
        },
        book_title: "Sample Book",
        book_metadata: {
          source: "youtube_transcript",
          url: "https://www.youtube.com/watch?v=abc",
          videoId: "abc",
        },
      },
      {
        id: "chunk-2",
        book_id: "book-1",
        chunk_index: 1,
        content: "Continuation text",
        token_count: 2,
        char_count: 17,
        metadata: {
          source: "youtube_transcript",
          url: "https://www.youtube.com/watch?v=abc",
        },
        book_title: "Sample Book",
        book_metadata: {
          source: "youtube_transcript",
          url: "https://www.youtube.com/watch?v=abc",
          videoId: "abc",
        },
      },
    ]);
    jest.mocked(chatRepository.persistChatTurn).mockResolvedValue({
      userMessage: {
        id: "message-user",
        conversation_id: "conversation-1",
        role: "user",
        content: "Question?",
        model: null,
        token_metadata: {},
        metadata: {},
        created_at: "now",
      },
      assistantMessage: {
        id: "message-assistant",
        conversation_id: "conversation-1",
        role: "assistant",
        content: "Assistant answer",
        model: "gemini-3.1-flash-lite-preview",
        token_metadata: {},
        metadata: {},
        created_at: "now",
      },
    });
  });

  it("embeds the query, expands to full documents, generates a response, and persists contexts", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "Question?",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.embed).toHaveBeenCalledWith(
      "task: question answering | query: Question?",
    );
    // Knowledge is global, so book searches must NOT be scoped by company.
    expect(booksRepository.searchBookChunks).toHaveBeenCalledWith(
      expect.any(Array),
      12,
    );
    expect(booksRepository.loadChunksForBooks).toHaveBeenCalledWith(["book-1"]);
    expect(gemini.generateWithTools).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("Relevant book text"),
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(gemini.generateWithTools).toHaveBeenCalledWith(
      expect.objectContaining({
        contents: expect.arrayContaining([
          expect.objectContaining({
            parts: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("Continuation text"),
              }),
            ]),
          }),
        ]),
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        contexts: expect.arrayContaining([
          expect.objectContaining({ id: "chunk-1", similarity: 0.9 }),
          expect.objectContaining({ id: "chunk-2" }),
        ]),
        assistantMetadata: expect.objectContaining({
          rag: expect.objectContaining({
            contexts: expect.arrayContaining([
              expect.objectContaining({
                chunkIndex: 0,
                contentPreview: expect.stringContaining("Relevant book text"),
              }),
            ]),
          }),
        }),
      }),
    );
  });

  it("dispatches a tool call, feeds the result back, and persists the trace", async () => {
    const calls: Array<{ contents: unknown; toolChoice: string }> = [];
    jest.mocked(gemini.generateWithTools).mockReset();
    jest
      .mocked(gemini.generateWithTools)
      .mockImplementationOnce(async (input: any) => {
        calls.push({ contents: input.contents, toolChoice: input.toolChoice });
        return {
          functionCalls: [
            {
              name: "list_recent_bulk_runs",
              args: { limit: 5 },
            },
          ] as never,
          text: "",
          model: "gemini-test",
        };
      })
      .mockImplementationOnce(async (input: any) => {
        calls.push({ contents: input.contents, toolChoice: input.toolChoice });
        return {
          functionCalls: [],
          text: "You have 1 recent bulk run.",
          model: "gemini-test",
        };
      });

    // Force the diagnostic-mode path so we exercise tools, and stub the
    // repository the dispatched tool calls into.
    const bulkRunsRepo = await import("../repositories/bulkRuns");
    jest.spyOn(bulkRunsRepo, "listBulkRuns").mockResolvedValue([] as never);

    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "why did the bulk run fail?",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.generateWithTools).toHaveBeenCalledTimes(2);
    // First turn requested a tool; second turn saw the tool-response and
    // produced the final answer.
    const second = calls[1].contents as Array<{ role: string; parts: unknown[] }>;
    expect(
      second.some(
        (turn) =>
          turn.role === "user" &&
          turn.parts.some(
            (p) =>
              typeof p === "object" &&
              p !== null &&
              "functionResponse" in p,
          ),
      ),
    ).toBe(true);
    expect(bulkRunsRepo.listBulkRuns).toHaveBeenCalledWith(TEST_COMPANY_ID, 5);
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantContent: "You have 1 recent bulk run.",
        assistantMetadata: expect.objectContaining({
          diagnosticMode: true,
          tools: expect.objectContaining({
            iterations: 2,
            calls: expect.arrayContaining([
              expect.objectContaining({ name: "list_recent_bulk_runs" }),
            ]),
          }),
        }),
      }),
    );
    // Diagnostic queries skip the embed call.
    expect(gemini.embed).not.toHaveBeenCalled();
  });

  it("rejects empty chat content", async () => {
    await expect(
      sendConversationMessage(
        {
          companyId: TEST_COMPANY_ID,
          conversationId: "conversation-1",
          content: " ",
          metadata: {},
        },
        gemini,
      ),
    ).rejects.toMatchObject({
      status: 400,
      message: "content is required",
    });
  });
});
