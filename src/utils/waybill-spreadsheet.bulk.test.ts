import { promises as fs } from "fs";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import {
  isSendableWaybillDraft,
  parseWaybillSpreadsheet,
} from "./waybill-spreadsheet";
import { validateWaybillForRs } from "./waybill-types";

const TYPE_LABELS: Record<number, string> = {
  1: "internal transfer",
  2: "transportation",
  3: "without transport",
  4: "distribution",
  5: "return",
  6: "sub-waybill",
};

function workbookVariant(index: number) {
  const waybillType = (index % 6) + 1;
  const needsBuyer = waybillType !== 1;
  const needsTransport = waybillType !== 3;
  const itemCount = (index % 3) + 1;
  const rows = Array.from({ length: itemCount }, (_, itemIndex) => ({
    reference: `xlsx-${String(index + 1).padStart(3, "0")}`,
    waybillType,
    waybillTypeLabel: TYPE_LABELS[waybillType],
    parentWaybillNumber: waybillType === 5 ? `WB-RETURN-${index + 1000}` : "",
    subWaybillNumbers: waybillType === 6 ? `SUB-${index}-A; SUB-${index}-B` : "",
    buyerName: needsBuyer ? `Excel Buyer ${index + 1}` : "",
    buyerTin: needsBuyer ? `${210000000 + index}` : "",
    startAddress: `Excel origin ${index % 7}`,
    endAddress: `Excel destination ${index % 11}`,
    driverName: needsTransport ? `Excel Driver ${index + 1}` : "",
    driverTin: needsTransport ? `${310000000 + index}` : "",
    carNumber: needsTransport ? `BB-${String(index).padStart(3, "0")}-CC` : "",
    docNumber: `XLS-DOC-${String(index + 1).padStart(3, "0")}`,
    date: `2026-07-${String((index % 20) + 1).padStart(2, "0")}`,
    itemName: `Excel item ${index + 1}.${itemIndex + 1}`,
    unit: ["pcs", "kg", "box"][itemIndex % 3],
    quantity: itemIndex + 1 + (index % 4),
    price: itemIndex % 2 === 0 ? 10.5 + index : `${10 + index},75`,
  }));
  return { waybillType, rows };
}

async function writeWorkbook(filePath: string, rows: ReturnType<typeof workbookVariant>["rows"]) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Waybills");
  sheet.addRow([
    "Reference",
    "Waybill Type",
    "Parent Waybill Number",
    "Sub Waybill Numbers",
    "Buyer Name",
    "Buyer TIN",
    "Start Address",
    "End Address",
    "Driver Name",
    "Driver TIN",
    "Car Number",
    "Doc Number",
    "Date",
    "Item",
    "Unit",
    "Qty",
    "Unit Price",
  ]);
  for (const row of rows) {
    sheet.addRow([
      row.reference,
      row.waybillTypeLabel,
      row.parentWaybillNumber,
      row.subWaybillNumbers,
      row.buyerName,
      row.buyerTin,
      row.startAddress,
      row.endAddress,
      row.driverName,
      row.driverTin,
      row.carNumber,
      row.docNumber,
      row.date,
      row.itemName,
      row.unit,
      row.quantity,
      row.price,
    ]);
  }
  await workbook.xlsx.writeFile(filePath);
}

describe("waybill spreadsheet bulk parser", () => {
  it("parses 50 uploaded XLSX variants across all waybill types", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-xlsx-"));
    try {
      for (let index = 0; index < 50; index += 1) {
        const expected = workbookVariant(index);
        const filePath = path.join(tmpDir, `waybill-${index + 1}.xlsx`);
        await writeWorkbook(filePath, expected.rows);

        const parsed = await parseWaybillSpreadsheet(filePath, path.basename(filePath));

        expect(parsed.rejectedRows).toEqual([]);
        expect(parsed.drafts).toHaveLength(1);
        const [draft] = parsed.drafts;
        expect(draft.reference).toBe(expected.rows[0].reference);
        expect(draft.waybill_type).toBe(expected.waybillType);
        expect(draft.items).toHaveLength(expected.rows.length);
        expect(draft.waybill_number).toBe(
          expected.waybillType === 5 ? expected.rows[0].parentWaybillNumber : undefined,
        );
        expect(draft.sub_waybill_numbers).toEqual(
          expected.waybillType === 6 ? ["SUB-" + index + "-A", "SUB-" + index + "-B"] : undefined,
        );
        expect(isSendableWaybillDraft(draft)).toBe(true);
        expect(
          validateWaybillForRs({
            type: draft.waybill_type,
            waybill_number: draft.waybill_number,
            sub_waybill_numbers: draft.sub_waybill_numbers,
            buyer_tin: draft.buyer_tin,
            buyer_name: draft.buyer_name,
            start_address: draft.start_address,
            end_address: draft.end_address,
            driver_tin: draft.driver_tin,
            driver_name: draft.driver_name,
            car_number: draft.car_number,
            items: draft.items,
          }),
        ).toEqual([]);
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});
