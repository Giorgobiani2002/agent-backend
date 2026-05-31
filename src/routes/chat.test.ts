import request from "supertest";
import { app } from "../index";
import { chatService } from "../services/chat";
import { TEST_COMPANY_ID, TEST_USER_ID, withTenant } from "../test-utils";

describe("chat routes", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  it("creates conversations", async () => {
    jest.spyOn(chatService, "createConversation").mockResolvedValue({
      id: "conversation-1",
      user_id: "user-1",
      company_id: TEST_COMPANY_ID,
      title: "Chat",
      metadata: {},
      created_at: "now",
      updated_at: "now",
    });

    const response = await withTenant(
      request(app).post("/chat/conversations"),
    ).send({
      userId: "user-1",
      title: "Chat",
    });

    expect(response.status).toBe(201);
    expect(response.body.conversation.id).toBe("conversation-1");
  });

  it("sends chat messages and returns contexts", async () => {
    jest.spyOn(chatService, "sendConversationMessage").mockResolvedValue({
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
        content: "Answer",
        model: "gemini-3.1-flash-lite-preview",
        token_metadata: {},
        metadata: {},
        created_at: "now",
      },
      contexts: [
        {
          id: "chunk-1",
          book_id: "book-1",
          chunk_index: 0,
          content: "Relevant text",
          token_count: 2,
          char_count: 13,
          metadata: {},
          rank: 1,
          similarity: 0.9,
        },
      ],
    });

    const response = await withTenant(
      request(app).post("/chat/conversations/conversation-1/messages"),
    ).send({ content: "Question?" });

    expect(response.status).toBe(201);
    expect(response.body.assistantMessage.content).toBe("Answer");
    expect(response.body.contexts).toHaveLength(1);
  });

  it("deletes conversations for a user", async () => {
    const deleteConversation = jest
      .spyOn(chatService, "deleteConversation")
      .mockResolvedValue(true);

    const response = await withTenant(
      request(app).delete("/chat/conversations/conversation-1"),
    ).query({ userId: "user-1" });

    expect(response.status).toBe(204);
    expect(deleteConversation).toHaveBeenCalledWith({
      companyId: TEST_COMPANY_ID,
      id: "conversation-1",
      userId: "user-1",
    });
  });

  it("returns 404 when deleting a missing conversation", async () => {
    jest.spyOn(chatService, "deleteConversation").mockResolvedValue(false);

    const response = await withTenant(
      request(app).delete("/chat/conversations/missing-conversation"),
    ).query({ userId: "user-1" });

    expect(response.status).toBe(404);
    expect(response.body.message).toBe("Conversation not found");
  });

  it("returns 400 for empty chat content", async () => {
    jest.spyOn(chatService, "sendConversationMessage").mockRejectedValue({
      status: 400,
      message: "content is required",
    });

    const response = await withTenant(
      request(app).post("/chat/conversations/conversation-1/messages"),
    ).send({ content: " " });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("content is required");
  });

  it("rejects requests with no internal secret", async () => {
    // Fail-closed: a request without the internal secret is forbidden.
    const response = await request(app)
      .post("/chat/conversations")
      .send({ userId: "user-1" });
    expect(response.status).toBe(403);
  });

  it("rejects authenticated requests missing the company header", async () => {
    const response = await request(app)
      .post("/chat/conversations")
      .set("X-Internal-Secret", "test-internal-secret")
      .send({ userId: "user-1" });
    expect(response.status).toBe(400);
    expect(response.body.message).toContain("X-Company-Id");
  });

  // Silence unused-import warning when only used via spread above.
  void TEST_USER_ID;
});
