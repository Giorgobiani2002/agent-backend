import fs from "fs/promises";
import os from "os";
import path from "path";
import ExcelJS from "exceljs";
import { parsePayrollSpreadsheet } from "./payroll-spreadsheet";

describe("parsePayrollSpreadsheet", () => {
  it("maps Georgian payroll columns and rejects duplicates and empty salary rows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-payroll-test-"));
    const file = path.join(dir, "salary.xlsx");
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("ხელფასები");
    sheet.addRow(["თანამშრომელი", "პირადი ნომერი", "დარიცხული ხელფასი", "საპენსიო"]);
    sheet.addRow(["ნინო ბერიძე", "01001000001", 2000, "კი"]);
    const formattedIdRow = sheet.addRow(["ანა ლომიძე", 2002000002, "1,500.00", "არა"]);
    formattedIdRow.getCell(2).numFmt = "00000000000";
    sheet.addRow(["ნინო ბერიძე", "01001000001", 2100, "კი"]);
    sheet.addRow(["გიორგი მაისურაძე", "02002000002", "", "არა"]);
    await workbook.xlsx.writeFile(file);

    try {
      const parsed = await parsePayrollSpreadsheet(file, "salary.xlsx");
      expect(parsed.columnMapping.name).toBe("თანამშრომელი");
      expect(parsed.columnMapping.gross).toBe("დარიცხული ხელფასი");
      expect(parsed.employees).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "ნინო ბერიძე",
            personal_id: "01001000001",
            gross: 2000,
            pension_participant: true,
          }),
          expect.objectContaining({
            name: "ანა ლომიძე",
            personal_id: "02002000002",
            gross: 1500,
            pension_participant: false,
          }),
        ]),
      );
      expect(parsed.rejectedRows).toHaveLength(2);
      expect(parsed.warnings.some((warning) => warning.includes("2 სტრიქონი"))).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("parses English CSV aliases and defaults a missing pension column to participant", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "declario-payroll-test-"));
    const file = path.join(dir, "salary.csv");
    await fs.writeFile(
      file,
      "Employee,Personal ID,Gross Salary\nJohn Doe,01001000001,1500\n",
      "utf8",
    );

    try {
      const parsed = await parsePayrollSpreadsheet(file, "salary.csv");
      expect(parsed.columnMapping.name).toBe("Employee");
      expect(parsed.columnMapping.gross).toBe("Gross Salary");
      expect(parsed.employees[0]).toEqual(
        expect.objectContaining({
          name: "John Doe",
          pension_participant: true,
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
