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

  it("parses Georgian waybill type labels", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-test-"));
    const file = path.join(dir, "typed-waybills.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Waybills");
    sheet.addRow([
      "Document Number",
      "ზედნადების ტიპი",
      "Buyer TIN",
      "Buyer Name",
      "Start Address",
      "End Address",
      "Item Name",
      "Quantity",
      "Unit Price",
    ]);
    sheet.addRow([
      "RET-1",
      "უკან დაბრუნება",
      "123456789",
      "Buyer A",
      "Batumi",
      "Tbilisi",
      "Returned goods",
      1,
      12,
    ]);
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parseWaybillSpreadsheet(file, "typed-waybills.xlsx");
      expect(parsed.columnMapping.waybill_type).toBe("ზედნადების ტიპი");
      expect(parsed.drafts).toHaveLength(1);
      expect(parsed.drafts[0]).toMatchObject({
        reference: "RET-1",
        waybill_type: 5,
        waybill_type_label: "უკან დაბრუნება",
      });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses all six waybill types from Excel labels and refs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-test-"));
    const file = path.join(dir, "all-types.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Waybills");
    sheet.addRow([
      "Document Number",
      "Waybill Type",
      "Parent Waybill Number",
      "Sub Waybill Numbers",
      "Buyer TIN",
      "Buyer Name",
      "Start Address",
      "End Address",
      "Driver Name",
      "Car Number",
      "Item Name",
      "Quantity",
      "Unit Price",
    ]);

    const rows = [
      ["INT-1", "internal transfer", "", "", "", "", "Warehouse A", "Warehouse B", "Driver", "AA111AA", "Item 1", 1, 10],
      ["TRN-1", "transportation", "", "", "123456789", "Buyer A", "Tbilisi", "Batumi", "Driver", "AA222AA", "Item 2", 2, 20],
      ["NTR-1", "without transport", "", "", "123456789", "Buyer B", "Tbilisi", "Tbilisi", "", "", "Item 3", 3, 30],
      ["DST-1", "distribution", "", "", "123456789", "Buyer C", "Tbilisi", "Kutaisi", "Driver", "AA333AA", "Item 4", 4, 40],
      ["RET-1", "return", "WB-ORIGINAL", "", "123456789", "Buyer D", "Batumi", "Tbilisi", "Driver", "AA444AA", "Item 5", 5, 50],
      ["SUB-1", "sub-waybill", "", "WB-1, WB-2", "123456789", "Buyer E", "Tbilisi", "Rustavi", "Driver", "AA555AA", "Item 6", 6, 60],
    ];
    rows.forEach((row) => sheet.addRow(row));
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parseWaybillSpreadsheet(file, "all-types.xlsx");
      expect(parsed.drafts).toHaveLength(6);
      expect(parsed.drafts.map((draft) => draft.waybill_type)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(parsed.drafts.find((draft) => draft.reference === "RET-1")).toMatchObject({
        waybill_number: "WB-ORIGINAL",
      });
      expect(parsed.drafts.find((draft) => draft.reference === "SUB-1")).toMatchObject({
        sub_waybill_numbers: ["WB-1", "WB-2"],
      });
      expect(isSendableWaybillDraft(parsed.drafts[0])).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts an internal-transfer sheet with no buyer column (type 1 needs no buyer)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-waybill-test-"));
    const file = path.join(dir, "internal.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Waybills");
    sheet.addRow([
      "Document Number",
      "Waybill Type",
      "Start Address",
      "End Address",
      "Driver Name",
      "Car Number",
      "Item Name",
      "Quantity",
      "Unit Price",
    ]);
    sheet.addRow([
      "INT-1",
      "internal transfer",
      "Warehouse A",
      "Warehouse B",
      "Driver",
      "AA111AA",
      "Box",
      3,
      4,
    ]);
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parseWaybillSpreadsheet(file, "internal.xlsx");
      expect(parsed.drafts).toHaveLength(1);
      expect(parsed.drafts[0]).toMatchObject({ reference: "INT-1", waybill_type: 1 });
      expect(isSendableWaybillDraft(parsed.drafts[0])).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
