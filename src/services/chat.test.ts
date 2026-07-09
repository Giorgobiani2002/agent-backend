import { sendConversationMessage } from "./chat";
import { GeminiService } from "./gemini";
import * as chatRepository from "../repositories/chat";
import * as booksRepository from "../repositories/books";
import * as attachmentRepository from "../repositories/chat-attachments";
import * as rateLimit from "./chat-rate-limit";
import * as waybillVision from "./waybill-vision";
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
    jest.mocked(gemini.embed).mockImplementation(async () => new Array(1536).fill(0.2));
    jest.mocked(gemini.generateChatResponse).mockImplementation(async () => ({
      text: "Assistant answer",
      model: "gemini-3.1-flash-lite-preview",
    }));
    jest.mocked(gemini.generateWithTools).mockImplementation(async () => ({
      functionCalls: [],
      text: "Assistant answer",
      model: "gemini-3.1-flash-lite-preview",
    }));
    jest.mocked(gemini.validateData).mockImplementation(async () => []);
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
        content: "finance bookkeeping concept",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.embed).toHaveBeenCalledWith(
      "task: question answering | query: finance bookkeeping concept",
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

  it("blocks off-topic political questions before calling Gemini", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "რას ფიქრობ სააკაშვილზე?",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.embed).not.toHaveBeenCalled();
    expect(gemini.generateWithTools).not.toHaveBeenCalled();
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "declario-domain-guard-v1",
        assistantContent: expect.stringContaining("ფინანს"),
        assistantMetadata: expect.objectContaining({
          domainGuard: expect.objectContaining({ blocked: true }),
        }),
        contexts: [],
      }),
    );
  });

  it("allows finance and tax questions through the normal chat path", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "დღგ როგორ გამოვთვალო მაისისთვის?",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.generateWithTools).toHaveBeenCalled();
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "gemini-3.1-flash-lite-preview",
      }),
    );
  });

  it("allows small entrepreneur income-tax filing questions", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "საშემოსავლო როგორ შევავსო მცირე მეწარმის?",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.generateWithTools).toHaveBeenCalled();
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "gemini-3.1-flash-lite-preview",
        assistantMetadata: expect.not.objectContaining({
          domainGuard: expect.objectContaining({ blocked: true }),
        }),
      }),
    );
  });

  it("allows Georgian shorthand questions about RS.ge connection status", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "ჯერ დაკავშირებული რო არ მაქვს რს?",
        metadata: {},
      },
      gemini,
    );

    expect(gemini.generateWithTools).toHaveBeenCalled();
    expect(gemini.embed).not.toHaveBeenCalled();
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "gemini-3.1-flash-lite-preview",
        assistantMetadata: expect.not.objectContaining({
          domainGuard: expect.objectContaining({ blocked: true }),
        }),
      }),
    );
  });

  it("explains the waybill photo upload flow without denying OCR support", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "ზედნადების ატვირთვა ფოტოდან მინდა, ეგ არ შეგიძლია?",
        metadata: {},
        userId: "user-1",
      },
      gemini,
    );

    expect(gemini.embed).not.toHaveBeenCalled();
    expect(gemini.generateWithTools).not.toHaveBeenCalled();
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "declario-waybill-photo-help-v1",
        assistantContent: expect.stringContaining("ფოტოს მიხედვით"),
        contexts: [],
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantContent: expect.stringContaining("მყიდველის ს/კ"),
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantContent: expect.stringContaining("შესწორება ჩატში"),
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantContent: expect.not.stringContaining("არ ხორციელდება"),
      }),
    );
  });

  it("explains the Excel waybill upload flow when the user mentions Excel", async () => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "დამეხმარე როგორ მოვიქცე ზედნადებები მაქვს ექსელში",
        metadata: {},
        userId: "user-1",
      },
      gemini,
    );

    expect(gemini.embed).not.toHaveBeenCalled();
    expect(gemini.generateWithTools).not.toHaveBeenCalled();
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "declario-waybill-spreadsheet-help-v1",
        assistantContent: expect.stringContaining("Excel"),
        contexts: [],
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantContent: expect.stringContaining("მყიდველის ს/კ"),
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantContent: expect.not.stringContaining("ზედნადების ფოტო"),
      }),
    );
  });

  it.each([
    {
      name: "Excel waybill guidance",
      content: "დამეხმარე როგორ მოვიქცე ზედნადებები მაქვს ექსელში",
      model: "declario-waybill-spreadsheet-help-v1",
      contains: ["Excel", "მყიდველის ს/კ", "preview"],
      notContains: ["ზედნადების ფოტო"],
      generateWithTools: false,
      embed: false,
    },
    {
      name: "photo waybill guidance",
      content: "ზედნადების ფოტო მაქვს და ჩატიდან როგორ გავაგზავნო?",
      model: "declario-waybill-photo-help-v1",
      contains: ["ფოტოს მიხედვით", "მყიდველის ს/კ", "შესწორება ჩატში"],
      notContains: ["Excel ფაილი"],
      generateWithTools: false,
      embed: false,
    },
    {
      name: "small entrepreneur income tax",
      content: "საშემოსავლო როგორ შევავსო მცირე მეწარმის?",
      model: "gemini-3.1-flash-lite-preview",
      contains: ["Assistant answer"],
      notContains: ["ამ თემაზე ვერ გიპასუხებთ"],
      generateWithTools: true,
      embed: true,
    },
    {
      name: "RS.ge connection status",
      content: "ჯერ დაკავშირებული რო არ მაქვს რს?",
      model: "gemini-3.1-flash-lite-preview",
      contains: ["Assistant answer"],
      notContains: ["ამ თემაზე ვერ გიპასუხებთ"],
      generateWithTools: true,
      embed: false,
    },
    {
      name: "general VAT knowledge",
      content: "დღგ რა განაკვეთით იანგარიშება საქართველოში?",
      model: "gemini-3.1-flash-lite-preview",
      contains: ["Assistant answer"],
      notContains: ["ამ თემაზე ვერ გიპასუხებთ"],
      generateWithTools: true,
      embed: true,
    },
    {
      name: "off-topic political question",
      content: "რას ფიქრობ სააკაშვილზე?",
      model: "declario-domain-guard-v1",
      contains: ["ფინანს"],
      notContains: ["Assistant answer"],
      generateWithTools: false,
      embed: false,
      blocked: true,
    },
  ])("routes real chat task: $name", async (task) => {
    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: task.content,
        metadata: {},
        userId: "user-1",
      },
      gemini,
    );

    const calls = jest.mocked(chatRepository.persistChatTurn).mock.calls;
    const persisted = calls[calls.length - 1]?.[0] as {
      assistantContent: string;
      assistantMetadata?: Record<string, unknown>;
      assistantModel: string;
    };
    expect(persisted.assistantModel).toBe(task.model);
    for (const expected of task.contains) {
      expect(persisted.assistantContent).toContain(expected);
    }
    for (const unexpected of task.notContains) {
      expect(persisted.assistantContent).not.toContain(unexpected);
    }
    if (task.blocked) {
      expect(persisted.assistantMetadata).toEqual(
        expect.objectContaining({
          domainGuard: expect.objectContaining({ blocked: true }),
        }),
      );
    } else {
      expect(persisted.assistantMetadata).not.toEqual(
        expect.objectContaining({
          domainGuard: expect.objectContaining({ blocked: true }),
        }),
      );
    }
    if (task.generateWithTools) {
      expect(gemini.generateWithTools).toHaveBeenCalled();
    } else {
      expect(gemini.generateWithTools).not.toHaveBeenCalled();
    }
    if (task.embed) {
      expect(gemini.embed).toHaveBeenCalled();
    } else {
      expect(gemini.embed).not.toHaveBeenCalled();
    }
  });

  it("updates the latest parsed waybill image when the user sends a correction", async () => {
    const currentAttachment: attachmentRepository.ChatAttachmentRow = {
      id: "11111111-1111-1111-1111-111111111111",
      company_id: TEST_COMPANY_ID,
      conversation_id: "conversation-1",
      user_id: "user-1",
      original_name: "waybill.jpg",
      mime_type: "image/jpeg",
      kind: "image",
      size_bytes: 100,
      status: "parsed",
      created_at: "now",
      parsed_data: {
        is_waybill: true,
        confidence: 0.9,
        buyer_name: "Buyer LLC",
        buyer_tin: "123456789",
        start_address: "Tbilisi",
        end_address: "Batumi",
        items: [{ w_name: "Coffee", quantity: 1, price: 12 }],
        warnings: [],
      },
    };
    const corrected = {
      is_waybill: true,
      confidence: 0.95,
      buyer_name: "Buyer LLC",
      buyer_tin: "123456789",
      start_address: "Tbilisi",
      end_address: "Batumi",
      items: [{ w_name: "Coffee", quantity: 1, price: 21 }],
      warnings: [],
    };
    jest.spyOn(attachmentRepository, "getLatestParsedAttachment").mockResolvedValue(currentAttachment);
    jest
      .spyOn(waybillVision, "applyWaybillCorrection")
      .mockResolvedValue({ changed: true, extraction: corrected });
    jest.spyOn(attachmentRepository, "updateChatAttachmentParsedData").mockResolvedValue({
      ...currentAttachment,
      parsed_data: corrected as unknown as Record<string, unknown>,
    });

    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "ფასი 12 კი არა 21",
        metadata: {},
        userId: "user-1",
      },
      gemini,
    );

    expect(attachmentRepository.updateChatAttachmentParsedData).toHaveBeenCalledWith(
      expect.objectContaining({
        attachmentId: currentAttachment.id,
        parsedData: corrected,
        status: "parsed",
      }),
    );
    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "declario-waybill-vision-v1",
        assistantMetadata: expect.objectContaining({
          pendingAction: expect.objectContaining({
            type: "waybill_send",
            attachmentId: currentAttachment.id,
            totalAmount: 21,
          }),
        }),
      }),
    );
    expect(gemini.embed).not.toHaveBeenCalled();
  });

  it("offers the send button for an internal-transfer (type 1) photo with no buyer TIN", async () => {
    const attachment: attachmentRepository.ChatAttachmentRow = {
      id: "22222222-2222-2222-2222-222222222222",
      company_id: TEST_COMPANY_ID,
      conversation_id: "conversation-1",
      user_id: "user-1",
      original_name: "internal.jpg",
      mime_type: "image/jpeg",
      kind: "image",
      size_bytes: 100,
      status: "parsed",
      created_at: "now",
      parsed_data: {
        is_waybill: true,
        confidence: 0.9,
        waybill_type: 1,
        buyer_name: "",
        buyer_tin: "",
        start_address: "Warehouse A",
        end_address: "Warehouse B",
        car_number: "AA111AA",
        driver_name: "Driver",
        items: [{ w_name: "Box", quantity: 3, price: 4 }],
        warnings: [],
      },
    };
    jest.spyOn(attachmentRepository, "getChatAttachments").mockResolvedValue([attachment]);

    await sendConversationMessage(
      {
        companyId: TEST_COMPANY_ID,
        conversationId: "conversation-1",
        content: "ატვირთე ეს ზედნადები",
        metadata: {},
        userId: "user-1",
        attachmentIds: [attachment.id],
      },
      gemini,
    );

    expect(chatRepository.persistChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        assistantModel: "declario-waybill-vision-v1",
        assistantMetadata: expect.objectContaining({
          pendingAction: expect.objectContaining({
            type: "waybill_send",
            waybillType: 1,
          }),
        }),
      }),
    );
  });
});
