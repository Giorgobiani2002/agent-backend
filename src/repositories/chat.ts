import { PoolClient } from "pg";
import { query, withTransaction } from "../db";
import { insertMessageContexts, BookChunkRow } from "./books";

export type MessageRole = "user" | "assistant" | "system";

export interface ConversationRow {
  id: string;
  user_id: string | null;
  company_id: string;
  title: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  model: string | null;
  token_metadata: Record<string, unknown>;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function createConversation(input: {
  companyId: string;
  userId?: string;
  title?: string;
  metadata: Record<string, unknown>;
}): Promise<ConversationRow> {
  const result = await query<ConversationRow>(
    `
      INSERT INTO conversations (user_id, company_id, title, metadata)
      VALUES ($1, $2, $3, $4)
      RETURNING *
    `,
    [input.userId ?? null, input.companyId, input.title ?? null, input.metadata],
  );

  return result.rows[0];
}

export async function listConversations(
  companyId: string,
  userId?: string,
): Promise<ConversationRow[]> {
  const result = await query<ConversationRow>(
    `
      SELECT *
      FROM conversations
      WHERE company_id = $1
        AND ($2::text IS NULL OR user_id = $2)
      ORDER BY updated_at DESC
    `,
    [companyId, userId ?? null],
  );

  return result.rows;
}

export async function getConversation(
  companyId: string,
  id: string,
): Promise<ConversationRow | null> {
  const result = await query<ConversationRow>(
    "SELECT * FROM conversations WHERE id = $1 AND company_id = $2",
    [id, companyId],
  );

  return result.rows[0] ?? null;
}

export async function deleteConversation(input: {
  companyId: string;
  id: string;
  userId?: string;
}): Promise<boolean> {
  const result = await query(
    `
      DELETE FROM conversations
      WHERE id = $1
        AND company_id = $2
        AND ($3::text IS NULL OR user_id = $3)
    `,
    [input.id, input.companyId, input.userId ?? null],
  );

  return (result.rowCount ?? 0) > 0;
}

export async function getMessages(conversationId: string): Promise<MessageRow[]> {
  const result = await query<MessageRow>(
    `
      SELECT *
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
    `,
    [conversationId],
  );

  return result.rows;
}

export async function getRecentMessages(
  conversationId: string,
  limit = 12,
): Promise<MessageRow[]> {
  const result = await query<MessageRow>(
    `
      SELECT *
      FROM messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [conversationId, limit],
  );

  return result.rows.reverse();
}

export async function createMessage(
  client: PoolClient,
  input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    model?: string;
    tokenMetadata?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): Promise<MessageRow> {
  const result = await client.query<MessageRow>(
    `
      INSERT INTO messages (
        conversation_id,
        role,
        content,
        model,
        token_metadata,
        metadata
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `,
    [
      input.conversationId,
      input.role,
      input.content,
      input.model ?? null,
      input.tokenMetadata ?? {},
      input.metadata ?? {},
    ],
  );

  await client.query(
    "UPDATE conversations SET updated_at = now() WHERE id = $1",
    [input.conversationId],
  );

  return result.rows[0];
}

export async function persistChatTurn(input: {
  conversationId: string;
  userContent: string;
  userMetadata: Record<string, unknown>;
  assistantContent: string;
  assistantModel: string;
  assistantMetadata: Record<string, unknown>;
  contexts: BookChunkRow[];
}): Promise<{ userMessage: MessageRow; assistantMessage: MessageRow }> {
  return withTransaction(async (client) => {
    const userMessage = await createMessage(client, {
      conversationId: input.conversationId,
      role: "user",
      content: input.userContent,
      metadata: input.userMetadata,
    });

    const assistantMessage = await createMessage(client, {
      conversationId: input.conversationId,
      role: "assistant",
      content: input.assistantContent,
      model: input.assistantModel,
      metadata: input.assistantMetadata,
    });

    await insertMessageContexts(client, assistantMessage.id, input.contexts);

    return { userMessage, assistantMessage };
  });
}
