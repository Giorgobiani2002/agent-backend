import { confirmWaybillAction, confirmWaybillSpreadsheetAction } from "./chat";
import * as chatRepository from "../repositories/chat";
import * as attachmentRepository from "../repositories/chat-attachments";
import type { ChatAttachmentRow } from "../repositories/chat-attachments";
import { rsServerClient } from "./rs-server-client";
import { TEST_COMPANY_ID, TEST_USER_ID } from "../test-utils";

jest.mock("../repositories/chat");
jest.mock("../repositories/chat-attachments");
jest.mock("./rs-server-client", () => ({
  rsServerClient: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

type RsPostCall = [
  string,
  {
    companyId: string;
    userId?: string;
    body?: Record<string, unknown>;
  },
];

const WAYBILL_TYPE_LABELS: Record<number, string> = {
  1: "internal transfer",
  2: "transportation",
  3: "without transport",
  4: "distribution",
  5: "return",
  6: "sub-waybill",
};

const CONVERSATION_ID = "conversation-bulk-waybill";

function uuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function variant(index: number) {
  const waybillType = (index % 6) + 1;
  const needsBuyer = waybillType !== 1;
  const needsTransport = waybillType !== 3;
  const itemCount = (index % 3) + 1;
  const items = Array.from({ length: itemCount }, (_, itemIndex) => ({
    w_name: `Bulk item ${index + 1}.${itemIndex + 1}`,
    unit_txt: ["pcs", "kg", "box"][itemIndex % 3],
    quantity: itemIndex + 1 + (index % 4),
    price: 4.5 + index + itemIndex * 0.25,
    source_row: itemIndex + 2,
  }));

  const buyerTin = `${200000000 + index}`;
  return {
    is_waybill: true,
    confidence: 0.78 + (index % 20) / 100,
    waybill_type: waybillType,
    waybill_type_label: WAYBILL_TYPE_LABELS[waybillType],
    waybill_number: waybillType === 5 ? `WB-RETURN-${1000 + index}` : undefined,
    sub_waybill_numbers:
      waybillType === 6
        ? [`SUB-${index}-A`, `SUB-${index}-B`]
        : undefined,
    seller_name: "Declario Test Seller",
    seller_tin: "206322102",
    buyer_name: needsBuyer ? `Buyer ${index + 1}` : undefined,
    buyer_tin: needsBuyer ? buyerTin : undefined,
    start_address: `Tbilisi warehouse ${index % 7}`,
    end_address: `Delivery address ${index % 11}`,
    driver_name: needsTransport ? `Driver ${index + 1}` : undefined,
    driver_tin: needsTransport ? `${300000000 + index}` : undefined,
    car_number: needsTransport ? `AA-${String(index).padStart(3, "0")}-BB` : undefined,
    document_number: `DOC-${String(index + 1).padStart(3, "0")}`,
    begin_date: `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
    items,
    source_rows: [index + 2],
    total_amount: Math.round(items.reduce((sum, item) => sum + item.quantity * item.price, 0) * 100) / 100,
    warnings: [],
  };
}

function attachment(input: {
  id: string;
  kind: "image" | "waybill_spreadsheet";
  name: string;
  parsedData: Record<string, unknown>;
  status?: "parsed" | "sent" | "rejected";
}): ChatAttachmentRow {
  return {
    id: input.id,
    company_id: TEST_COMPANY_ID,
    conversation_id: CONVERSATION_ID,
    user_id: TEST_USER_ID,
    original_name: input.name,
    mime_type:
      input.kind === "image"
        ? "image/png"
        : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: input.kind,
    size_bytes: 1234,
    status: input.status ?? "parsed",
    parsed_data: input.parsedData,
    created_at: "2026-07-10T00:00:00.000Z",
  };
}

function expectPayloadMatchesVariant(
  body: Record<string, unknown>,
  expected: ReturnType<typeof variant>,
) {
  expect(body.waybill_type).toBe(expected.waybill_type);
  expect(body.waybill_number).toBe(expected.waybill_number);
  expect(body.sub_waybill_numbers).toEqual(expected.sub_waybill_numbers ?? []);
  expect(body.buyer_tin).toBe(expected.buyer_tin);
  expect(body.buyer_name).toBe(expected.buyer_name ?? "");
  expect(body.start_address).toBe(expected.start_address);
  expect(body.end_address).toBe(expected.end_address);
  expect(body.driver_name).toBe(expected.driver_name);
  expect(body.car_number).toBe(expected.car_number);
  expect(body.begin_date).toBe(expected.begin_date);
  expect(body.items).toEqual(
    expected.items.map((item) => ({
      w_name: item.w_name,
      unit_txt: item.unit_txt,
      quantity: item.quantity,
      price: item.price,
    })),
  );
}

describe("chat waybill bulk confirm flows", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(chatRepository.getConversation).mockResolvedValue({
      id: CONVERSATION_ID,
      user_id: TEST_USER_ID,
      company_id: TEST_COMPANY_ID,
      title: null,
      metadata: {},
      created_at: "2026-07-10T00:00:00.000Z",
      updated_at: "2026-07-10T00:00:00.000Z",
    });
    jest
      .mocked(rsServerClient.post)
      .mockImplementation(async (_path, opts) => ({
        dry_run: true,
        reference: (opts.body as Record<string, unknown>).reference,
      }));
    jest
      .mocked(attachmentRepository.markChatAttachmentStatus)
      .mockImplementation(async () => null);
  });

  it("confirms 50 photo-upload waybill variants from chat without losing type-specific fields", async () => {
    const variants = Array.from({ length: 50 }, (_, index) => variant(index));

    for (const [index, parsedData] of variants.entries()) {
      const row = attachment({
        id: uuid(index + 1),
        kind: "image",
        name: `waybill-photo-${index + 1}.png`,
        parsedData,
      });
      jest.mocked(attachmentRepository.getChatAttachmentById).mockResolvedValueOnce(row);
      jest.mocked(attachmentRepository.claimImageAttachmentForSend).mockResolvedValueOnce(row);

      const result = await confirmWaybillAction({
        companyId: TEST_COMPANY_ID,
        conversationId: CONVERSATION_ID,
        userId: TEST_USER_ID,
        attachmentId: row.id,
      });

      expect(result).toEqual({
        dry_run: true,
        reference: `photo:${row.id}`,
      });
    }

    expect(rsServerClient.post).toHaveBeenCalledTimes(50);
    const calls = jest.mocked(rsServerClient.post).mock.calls as RsPostCall[];
    calls.forEach(([path, opts], index) => {
      expect(path).toBe("/internal/tools/waybills/save-and-send");
      expect(opts.companyId).toBe(TEST_COMPANY_ID);
      expect(opts.userId).toBe(TEST_USER_ID);
      expect(opts.body?.reference).toBe(`photo:${uuid(index + 1)}`);
      expect(opts.body?.send).toBe(true);
      expectPayloadMatchesVariant(opts.body ?? {}, variants[index]);
    });
  });

  it("confirms 50 Excel-upload waybill variants from chat as one spreadsheet batch", async () => {
    const drafts = Array.from({ length: 50 }, (_, index) => {
      const parsed = variant(index);
      return {
        ...parsed,
        reference: `excel-${String(index + 1).padStart(3, "0")}`,
      };
    });
    const row = attachment({
      id: uuid(999),
      kind: "waybill_spreadsheet",
      name: "bulk-waybills.xlsx",
      parsedData: { drafts, warnings: [] },
    });
    jest.mocked(attachmentRepository.getChatAttachmentById).mockResolvedValueOnce(row);
    jest.mocked(attachmentRepository.claimAttachmentForSend).mockResolvedValueOnce(row);

    const result = await confirmWaybillSpreadsheetAction({
      companyId: TEST_COMPANY_ID,
      conversationId: CONVERSATION_ID,
      userId: TEST_USER_ID,
      attachmentId: row.id,
    });

    expect(result).toMatchObject({ sent: 50, failed: 0, failures: [] });
    expect(rsServerClient.post).toHaveBeenCalledTimes(50);
    const calls = jest.mocked(rsServerClient.post).mock.calls as RsPostCall[];
    calls.forEach(([path, opts], index) => {
      expect(path).toBe("/internal/tools/waybills/save-and-send");
      expect(opts.companyId).toBe(TEST_COMPANY_ID);
      expect(opts.userId).toBe(TEST_USER_ID);
      expect(opts.body?.reference).toBe(
        `spreadsheet:${row.id}:excel-${String(index + 1).padStart(3, "0")}`,
      );
      expect(opts.body?.send).toBe(true);
      expect(opts.body?.comment).toBe(`Imported from spreadsheet document ${drafts[index].document_number}`);
      expectPayloadMatchesVariant(opts.body ?? {}, drafts[index]);
    });
    expect(attachmentRepository.markChatAttachmentStatus).toHaveBeenCalledWith({
      companyId: TEST_COMPANY_ID,
      attachmentId: row.id,
      status: "sent",
      mergeParsedData: { sent_result: expect.objectContaining({ sent: 50, failed: 0 }) },
    });
  });
});
