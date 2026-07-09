import fs from "fs/promises";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import {
  isSendableWaybillDraft,
  parseWaybillSpreadsheet,
} from "./waybill-spreadsheet";

describe("parseWaybillSpreadsheet", () => {
  it("groups spreadsheet rows into sendable waybill drafts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-test-"));
    const file = path.join(dir, "waybills.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Waybills");
    sheet.addRow([
      "Document Number",
      "Buyer TIN",
      "Buyer Name",
      "Start Address",
      "End Address",
      "Item Name",
      "Unit",
      "Quantity",
      "Unit Price",
    ]);
    sheet.addRow([
      "WB-1",
      "123456789",
      "Buyer LLC",
      "Tbilisi",
      "Batumi",
      "Coffee",
      "kg",
      2,
      10,
    ]);
    sheet.addRow([
      "WB-1",
      "123456789",
      "Buyer LLC",
      "Tbilisi",
      "Batumi",
      "Tea",
      "box",
      "3",
      "4.50",
    ]);
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parseWaybillSpreadsheet(file, "waybills.xlsx");
      expect(parsed.drafts).toHaveLength(1);
      expect(parsed.drafts[0]).toMatchObject({
        reference: "WB-1",
        buyer_tin: "123456789",
        buyer_name: "Buyer LLC",
        start_address: "Tbilisi",
        end_address: "Batumi",
        total_amount: 33.5,
      });
      expect(parsed.drafts[0].items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ w_name: "Coffee", quantity: 2, price: 10 }),
          expect.objectContaining({ w_name: "Tea", quantity: 3, price: 4.5 }),
        ]),
      );
      expect(isSendableWaybillDraft(parsed.drafts[0])).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns warnings instead of drafts when required columns are missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-test-"));
    const file = path.join(dir, "bad.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Waybills");
    sheet.addRow(["Buyer TIN", "Item Name", "Quantity"]);
    sheet.addRow(["123456789", "Coffee", 2]);
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parseWaybillSpreadsheet(file, "bad.xlsx");
      expect(parsed.drafts).toHaveLength(0);
      expect(parsed.warnings.join(" ")).toContain("price");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("uses Shopify/ICS reference columns to group manual waybill rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-test-"));
    const file = path.join(dir, "shopify-waybills.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Waybills");
    sheet.addRow([
      "Shopify Order Number",
      "Buyer TIN",
      "Buyer Name",
      "Start Address",
      "End Address",
      "Item Name",
      "Quantity",
      "Unit Price",
    ]);
    sheet.addRow(["#ME-1-GE", "123456789", "Buyer A", "Tbilisi", "Batumi", "Coffee", 1, 10]);
    sheet.addRow(["#ME-1-GE", "123456789", "Buyer A", "Tbilisi", "Batumi", "Tea", 2, 5]);
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parseWaybillSpreadsheet(file, "shopify-waybills.xlsx");
      expect(parsed.columnMapping.reference).toBe("Shopify Order Number");
      expect(parsed.drafts).toHaveLength(1);
      expect(parsed.drafts[0]).toMatchObject({
        reference: "#ME-1-GE",
        total_amount: 20,
      });
      expect(parsed.drafts[0].items).toHaveLength(2);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
