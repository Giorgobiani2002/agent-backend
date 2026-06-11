import { query } from "../db";

export interface ChatAttachmentRow {
  id: string;
  company_id: string;
  conversation_id: string;
  user_id: string | null;
  original_name: string;
  mime_type: string;
  kind: "payroll_spreadsheet";
  size_bytes: number;
  status: "parsed" | "rejected";
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
  status: "parsed" | "rejected";
  parsedData: Record<string, unknown>;
}): Promise<ChatAttachmentRow> {
  const result = await query<ChatAttachmentRow>(
    `
      INSERT INTO chat_attachments (
        company_id, conversation_id, user_id, original_name, mime_type,
        kind, size_bytes, status, parsed_data
      )
      VALUES ($1, $2, $3, $4, $5, 'payroll_spreadsheet', $6, $7, $8)
      RETURNING *
    `,
    [
      input.companyId,
      input.conversationId,
      input.userId ?? null,
      input.originalName,
      input.mimeType,
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
