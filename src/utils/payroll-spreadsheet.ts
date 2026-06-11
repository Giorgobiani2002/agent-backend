import ExcelJS from "exceljs";

export interface PayrollSpreadsheetEmployee {
  name: string;
  personal_id?: string;
  gross: number;
  pension_participant: boolean;
  source_row: number;
}

export interface PayrollSpreadsheetResult {
  headers: string[];
  columnMapping: {
    name?: string;
    personal_id?: string;
    gross?: string;
    pension_participant?: string;
  };
  employees: PayrollSpreadsheetEmployee[];
  warnings: string[];
  rejectedRows: Array<{ row: number; reason: string }>;
}

const COLUMN_ALIASES = {
  name: [
    "employee",
    "employee name",
    "full name",
    "name",
    "თანამშრომელი",
    "თანამშრომლის სახელი",
    "სახელი",
    "სახელი გვარი",
    "სახელი და გვარი",
  ],
  personal_id: [
    "personal id",
    "personal number",
    "personal_id",
    "id number",
    "პირადი ნომერი",
    "პ/ნ",
    "პნ",
  ],
  gross: [
    "gross",
    "gross salary",
    "gross_salary",
    "salary",
    "დარიცხული",
    "დარიცხული ხელფასი",
    "ხელფასი",
  ],
  pension_participant: [
    "pension",
    "pension participant",
    "pension_participant",
    "funded pension",
    "საპენსიო",
    "საპენსიო სტატუსი",
    "პენსია",
  ],
} as const;

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .toLocaleLowerCase("ka-GE")
    .replace(/[_-]+/g, " ")
    .replace(/[.:()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cellText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value) return String((value as { text?: unknown }).text ?? "").trim();
    if ("result" in value) return cellText((value as { result?: unknown }).result);
    if ("richText" in value) {
      return ((value as { richText?: Array<{ text?: string }> }).richText ?? [])
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    }
  }
  return String(value).trim();
}

function excelCellText(cell: ExcelJS.Cell): string {
  const displayed = String(cell.text ?? "").trim();
  return displayed || cellText(cell.value);
}

function findColumn(headers: string[], aliases: readonly string[]): string | undefined {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  return headers.find((header) => normalizedAliases.has(normalizeHeader(header)));
}

function parseGross(value: string): number | null {
  let normalized = value.replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    normalized =
      comma > dot
        ? normalized.replace(/\./g, "").replace(",", ".")
        : normalized.replace(/,/g, "");
  } else if (comma >= 0) {
    normalized = /^\d{1,3}(,\d{3})+$/.test(normalized)
      ? normalized.replace(/,/g, "")
      : normalized.replace(",", ".");
  } else if ((normalized.match(/\./g) ?? []).length > 1) {
    normalized = normalized.replace(/\./g, "");
  }
  if (!normalized) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null;
}

function parsePension(value: string): boolean {
  const normalized = normalizeHeader(value);
  if (!normalized) return true;
  if (["არა", "no", "false", "0", "არ არის", "non participant"].includes(normalized)) {
    return false;
  }
  return true;
}

async function loadWorkbook(filePath: string, originalName: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(originalName)) {
    await workbook.csv.readFile(filePath);
  } else {
    await workbook.xlsx.readFile(filePath);
  }
  return workbook;
}

export async function parsePayrollSpreadsheet(
  filePath: string,
  originalName: string,
): Promise<PayrollSpreadsheetResult> {
  const workbook = await loadWorkbook(filePath, originalName);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return {
      headers: [],
      columnMapping: {},
      employees: [],
      warnings: ["ფაილში სამუშაო ფურცელი ვერ მოიძებნა."],
      rejectedRows: [],
    };
  }

  let headerRowNumber = 0;
  sheet.eachRow({ includeEmpty: false }, (_row, rowNumber) => {
    if (!headerRowNumber) headerRowNumber = rowNumber;
  });
  if (!headerRowNumber) {
    return {
      headers: [],
      columnMapping: {},
      employees: [],
      warnings: ["ფაილი ცარიელია."],
      rejectedRows: [],
    };
  }

  const headerRow = sheet.getRow(headerRowNumber);
  const headers: string[] = [];
  const columnByHeader = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const header = excelCellText(cell);
    if (header) {
      headers.push(header);
      columnByHeader.set(header, columnNumber);
    }
  });

  const columnMapping = {
    name: findColumn(headers, COLUMN_ALIASES.name),
    personal_id: findColumn(headers, COLUMN_ALIASES.personal_id),
    gross: findColumn(headers, COLUMN_ALIASES.gross),
    pension_participant: findColumn(headers, COLUMN_ALIASES.pension_participant),
  };
  const warnings: string[] = [];
  if (!columnMapping.name) warnings.push("თანამშრომლის სახელის სვეტი ვერ მოიძებნა.");
  if (!columnMapping.gross) warnings.push("დარიცხული ხელფასის სვეტი ვერ მოიძებნა.");
  if (!columnMapping.personal_id) warnings.push("პირადი ნომრის სვეტი ვერ მოიძებნა.");
  if (!columnMapping.pension_participant) {
    warnings.push("საპენსიო სტატუსის სვეტი ვერ მოიძებნა; ნაგულისხმევად მონაწილედ ჩაითვალა.");
  }

  if (!columnMapping.name || !columnMapping.gross) {
    return { headers, columnMapping, employees: [], warnings, rejectedRows: [] };
  }

  const valueAt = (row: ExcelJS.Row, header?: string): string =>
    header ? excelCellText(row.getCell(columnByHeader.get(header) ?? 0)) : "";
  const personalIdAt = (row: ExcelJS.Row): string => {
    if (!columnMapping.personal_id) return "";
    const cell = row.getCell(columnByHeader.get(columnMapping.personal_id) ?? 0);
    if (typeof cell.value === "number" && Number.isInteger(cell.value)) {
      return String(cell.value).padStart(11, "0");
    }
    return excelCellText(cell);
  };
  const employees: PayrollSpreadsheetEmployee[] = [];
  const rejectedRows: Array<{ row: number; reason: string }> = [];
  const seen = new Set<string>();

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return;
    const name = valueAt(row, columnMapping.name);
    const grossText = valueAt(row, columnMapping.gross);
    if (!name && !grossText) return;

    const gross = parseGross(grossText);
    if (!name) {
      rejectedRows.push({ row: rowNumber, reason: "თანამშრომლის სახელი ცარიელია." });
      return;
    }
    if (gross == null) {
      rejectedRows.push({ row: rowNumber, reason: "ხელფასი ცარიელი, ნულოვანი ან არასწორია." });
      return;
    }

    const personalId = personalIdAt(row).replace(/\s/g, "");
    const key = personalId || normalizeHeader(name);
    if (seen.has(key)) {
      rejectedRows.push({ row: rowNumber, reason: "დუბლირებული თანამშრომელია." });
      return;
    }
    seen.add(key);
    if (personalId && !/^\d{11}$/.test(personalId)) {
      warnings.push(`სტრიქონი ${rowNumber}: პირადი ნომერი 11 ციფრი არ არის.`);
    }

    employees.push({
      name,
      ...(personalId ? { personal_id: personalId } : {}),
      gross,
      pension_participant: parsePension(valueAt(row, columnMapping.pension_participant)),
      source_row: rowNumber,
    });
  });

  if (rejectedRows.length) {
    warnings.push(`${rejectedRows.length} სტრიქონი validation-ის გამო გამოტოვებულია.`);
  }
  if (employees.length > 500) {
    warnings.push("ერთ ატვირთვაზე დასაშვებია მაქსიმუმ 500 თანამშრომელი.");
    employees.splice(500);
  }

  return { headers, columnMapping, employees, warnings, rejectedRows };
}
