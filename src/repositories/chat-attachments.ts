import { query } from "../db";

export type ChatAttachmentKind = "payroll_spreadsheet" | "image";
export type ChatAttachmentStatus = "parsed" | "rejected" | "sent";

export interface ChatAttachmentRow {
  id: string;
  company_id: string;
  conversation_id: string;
  user_id: string | null;
  original_name: string;
  mime_type: string;
  kind: ChatAttachmentKind;
  size_bytes: number;
  status: ChatAttachmentStatus;
  parsed_data: Record<string, unknown>;
  created_at: string;
}

export async function createChatAttachment(input: {
  companyId: string;
  conversationId: string;
  userId?: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  kind?: ChatAttachmentKind;
  status: ChatAttachmentStatus;
  parsedData: Record<string, unknown>;
}): Promise<ChatAttachmentRow> {
  const result = await query<ChatAttachmentRow>(
    `
      INSERT INTO chat_attachments (
        company_id, conversation_id, user_id, original_name, mime_type,
        kind, size_bytes, status, parsed_data
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `,
    [
      input.companyId,
      input.conversationId,
      input.userId ?? null,
      input.originalName,
      input.mimeType,
      input.kind ?? "payroll_spreadsheet",
      input.sizeBytes,
      input.status,
      input.parsedData,
    ],
  );
  return result.rows[0];
}

export async function getChatAttachments(input: {
  companyId: string;
  conversationId: string;
  attachmentIds: string[];
  userId?: string;
}): Promise<ChatAttachmentRow[]> {
  if (!input.attachmentIds.length) return [];
  const result = await query<ChatAttachmentRow>(
    `
      SELECT *
      FROM chat_attachments
      WHERE company_id = $1
        AND conversation_id = $2
        AND id = ANY($3::uuid[])
        AND ($4::text IS NULL OR user_id = $4)
      ORDER BY created_at ASC
    `,
    [
      input.companyId,
      input.conversationId,
      input.attachmentIds,
      input.userId ?? null,
    ],
  );
  return result.rows;
}

/** Single attachment by id within a conversation — used by the confirm flow. */
export async function getChatAttachmentById(input: {
  companyId: string;
  conversationId: string;
  attachmentId: string;
  userId?: string;
}): Promise<ChatAttachmentRow | null> {
  const result = await query<ChatAttachmentRow>(
    `
      SELECT *
      FROM chat_attachments
      WHERE company_id = $1
        AND conversation_id = $2
        AND id = $3::uuid
        AND ($4::text IS NULL OR user_id = $4)
      LIMIT 1
    `,
    [
      input.companyId,
      input.conversationId,
      input.attachmentId,
      input.userId ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Atomically claim an image attachment for sending: flip 'parsed' → 'sent' in
 * one statement and return the row only if THIS call won the race. A second
 * concurrent confirm gets null and must not file the waybill again. Callers
 * revert to 'parsed' if the downstream rs.ge call fails (so a genuine
 * pre-send failure can be retried).
 */
export async function claimImageAttachmentForSend(input: {
  companyId: string;
  attachmentId: string;
}): Promise<ChatAttachmentRow | null> {
  const result = await query<ChatAttachmentRow>(
    `
      UPDATE chat_attachments
      SET status = 'sent'
      WHERE company_id = $1 AND id = $2::uuid AND kind = 'image' AND status = 'parsed'
      RETURNING *
    `,
    [input.companyId, input.attachmentId],
  );
  return result.rows[0] ?? null;
}

/**
 * Flip an attachment's status and merge extra keys into `parsed_data`.
 * Used to mark a waybill image 'sent' (idempotency guard) and stash the
 * rs.ge result (waybill id / number) on the row for audit.
 */
export async function markChatAttachmentStatus(input: {
  companyId: string;
  attachmentId: string;
  status: ChatAttachmentStatus;
  mergeParsedData?: Record<string, unknown>;
}): Promise<ChatAttachmentRow | null> {
  const result = await query<ChatAttachmentRow>(
    `
      UPDATE chat_attachments
      SET status = $3,
          parsed_data = parsed_data || $4::jsonb
      WHERE company_id = $1 AND id = $2::uuid
      RETURNING *
    `,
    [
      input.companyId,
      input.attachmentId,
      input.status,
      JSON.stringify(input.mergeParsedData ?? {}),
    ],
  );
  return result.rows[0] ?? null;
}
