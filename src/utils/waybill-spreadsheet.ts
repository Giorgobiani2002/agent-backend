import ExcelJS from "exceljs";

export interface WaybillSpreadsheetItem {
  w_name: string;
  unit_txt?: string;
  quantity: number;
  price: number;
  source_row: number;
}

export interface WaybillSpreadsheetDraft {
  reference: string;
  waybill_type?: number;
  waybill_type_label?: string;
  buyer_name?: string;
  buyer_tin?: string;
  start_address?: string;
  end_address?: string;
  driver_name?: string;
  driver_tin?: string;
  car_number?: string;
  document_number?: string;
  begin_date?: string;
  items: WaybillSpreadsheetItem[];
  source_rows: number[];
  total_amount: number;
  warnings: string[];
}

export interface WaybillSpreadsheetResult {
  headers: string[];
  headerRow: number | null;
  columnMapping: Partial<Record<WaybillColumn, string>>;
  drafts: WaybillSpreadsheetDraft[];
  warnings: string[];
  rejectedRows: Array<{ row: number; reason: string }>;
}

const COLUMN_ALIASES = {
  reference: [
    "reference",
    "ref",
    "group",
    "order id",
    "order_id",
    "order",
    "shopify order",
    "shopify order id",
    "shopify order number",
    "case",
    "case number",
    "case_number",
    "tracking",
    "tracking number",
    "tracking_number",
    "fedex transit id",
    "fedex_transit_id",
    "document",
    "document number",
    "doc no",
    "waybill",
    "waybill number",
    "ზედნადების ნომერი",
    "დოკუმენტის ნომერი",
    "შეკვეთის ნომერი",
    "ნომერი",
    "ჯგუფი",
  ],
  waybill_type: [
    "waybill type",
    "type",
    "ზედნადების ტიპი",
    "ტიპი",
    "შიდა გადაზიდვა",
    "ტრანსპორტირება",
    "ტრანსპორტირების გარეშე",
    "დისტრიბუცია",
    "უკან დაბრუნება",
  ],
  buyer_name: [
    "buyer",
    "buyer name",
    "customer",
    "customer name",
    "client",
    "client name",
    "მყიდველი",
    "მყიდველის დასახელება",
    "კლიენტი",
    "კლიენტის დასახელება",
  ],
  buyer_tin: [
    "buyer tin",
    "buyer_tin",
    "buyer id",
    "tax id",
    "tin",
    "identification code",
    "მყიდველის ს/კ",
    "მყიდველის საიდენტიფიკაციო",
    "საიდენტიფიკაციო",
    "ს/კ",
  ],
  start_address: [
    "start address",
    "from address",
    "ship from",
    "origin",
    "pickup address",
    "გამგზავნის მისამართი",
    "გასვლის მისამართი",
    "საიდან",
    "საწყისი მისამართი",
  ],
  end_address: [
    "end address",
    "to address",
    "ship to",
    "destination",
    "delivery address",
    "მიმღების მისამართი",
    "დანიშნულების მისამართი",
    "სად",
    "ჩაბარების მისამართი",
  ],
  driver_name: ["driver", "driver name", "მძღოლი", "მძღოლის სახელი"],
  driver_tin: [
    "driver tin",
    "driver id",
    "driver personal id",
    "მძღოლის ს/კ",
    "მძღოლის პირადი ნომერი",
  ],
  car_number: [
    "car",
    "car number",
    "vehicle",
    "plate",
    "plate number",
    "მანქანის ნომერი",
    "ავტომობილის ნომერი",
  ],
  document_number: [
    "document_number",
    "document no",
    "doc number",
    "დოკუმენტის #",
    "დოკუმენტის ნომერი",
  ],
  begin_date: [
    "date",
    "begin date",
    "shipment date",
    "waybill date",
    "თარიღი",
    "გაგზავნის თარიღი",
  ],
  item_name: [
    "item",
    "item name",
    "goods",
    "goods name",
    "product",
    "product name",
    "description",
    "საქონელი",
    "საქონლის დასახელება",
    "დასახელება",
    "პროდუქტი",
  ],
  unit_txt: ["unit", "unit text", "uom", "measure", "ერთეული", "ზომის ერთეული"],
  quantity: [
    "qty",
    "quantity",
    "amount",
    "რაოდენობა",
    "რაოდ",
  ],
  price: [
    "price",
    "unit price",
    "unit_price",
    "ფასი",
    "ერთეულის ფასი",
    "ერთ. ფასი",
  ],
} as const;

type WaybillColumn = keyof typeof COLUMN_ALIASES;

function parseWaybillType(value: string): number | undefined {
  const text = value.trim().toLowerCase();
  if (!text) return undefined;
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n <= 6) return n;
  if (/უკან\s*დაბრუნ|დაბრუნებ|return/.test(text)) return 5;
  if (/დისტრიბუც|distribution/.test(text)) return 4;
  if (/ტრანსპორტირების\s*გარეშე|without\s*transport/.test(text)) return 3;
  if (/შიდა\s*გადაზიდ|inner|internal/.test(text)) return 1;
  if (/ტრანსპორტირებ|გადაზიდ|transport/.test(text)) return 2;
  return undefined;
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .toLocaleLowerCase("ka-GE")
    .replace(/[_-]+/g, " ")
    .replace(/[.:#()]/g, "")
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

async function loadWorkbook(filePath: string, originalName: string): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  if (/\.csv$/i.test(originalName)) {
    await workbook.csv.readFile(filePath);
  } else {
    await workbook.xlsx.readFile(filePath);
  }
  return workbook;
}

function parsePositiveAmount(value: string): number | null {
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
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 10000) / 10000 : null;
}

function normalizeTinText(value: string): string {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length > 0 && digits.length < 9) return digits.padStart(9, "0");
  return digits;
}

function aliasFieldForHeader(header: string): WaybillColumn | null {
  const normalized = normalizeHeader(header);
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as Array<
    [WaybillColumn, readonly string[]]
  >) {
    if (aliases.map(normalizeHeader).includes(normalized)) return field;
  }
  return null;
}

function inspectHeaderRow(row: ExcelJS.Row): {
  headers: string[];
  columnByField: Partial<Record<WaybillColumn, number>>;
  columnMapping: Partial<Record<WaybillColumn, string>>;
  score: number;
} {
  const headers: string[] = [];
  const columnByField: Partial<Record<WaybillColumn, number>> = {};
  const columnMapping: Partial<Record<WaybillColumn, string>> = {};
  let score = 0;
  row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const header = excelCellText(cell);
    if (!header) return;
    headers.push(header);
    const field = aliasFieldForHeader(header);
    if (field && !columnByField[field]) {
      columnByField[field] = columnNumber;
      columnMapping[field] = header;
      score += 1;
    }
  });
  return { headers, columnByField, columnMapping, score };
}

function findHeaderRow(sheet: ExcelJS.Worksheet): {
  rowNumber: number | null;
  headers: string[];
  columnByField: Partial<Record<WaybillColumn, number>>;
  columnMapping: Partial<Record<WaybillColumn, string>>;
} {
  let best:
    | {
        rowNumber: number;
        headers: string[];
        columnByField: Partial<Record<WaybillColumn, number>>;
        columnMapping: Partial<Record<WaybillColumn, string>>;
        score: number;
      }
    | null = null;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber > 20) return;
    const inspected = inspectHeaderRow(row);
    if (
      inspected.score > 0 &&
      (!best ||
        inspected.score > best.score ||
        (inspected.score === best.score && inspected.headers.length > best.headers.length))
    ) {
      best = { rowNumber, ...inspected };
    }
  });

  if (!best) {
    return { rowNumber: null, headers: [], columnByField: {}, columnMapping: {} };
  }
  return best;
}

function valueAt(
  row: ExcelJS.Row,
  columnByField: Partial<Record<WaybillColumn, number>>,
  field: WaybillColumn,
): string {
  const column = columnByField[field];
  return column ? excelCellText(row.getCell(column)).trim() : "";
}

function mergeDraftField(
  draft: WaybillSpreadsheetDraft,
  field: keyof Omit<
    WaybillSpreadsheetDraft,
    | "reference"
    | "waybill_type"
    | "items"
    | "source_rows"
    | "total_amount"
    | "warnings"
  >,
  value: string,
  label: string,
): void {
  if (!value) return;
  const current = draft[field];
  if (!current) {
    draft[field] = value;
  } else if (current !== value) {
    draft.warnings.push(`${label} differs across grouped rows; keeping "${current}".`);
  }
}

export function isSendableWaybillDraft(draft: WaybillSpreadsheetDraft): boolean {
  return Boolean(
    draft.buyer_tin &&
      /^\d{9}(\d{2})?$/.test(draft.buyer_tin) &&
      draft.buyer_name &&
      draft.start_address &&
      draft.end_address &&
      draft.items.length > 0 &&
      draft.items.every((item) => item.w_name && item.quantity > 0 && item.price > 0),
  );
}

export async function parseWaybillSpreadsheet(
  filePath: string,
  originalName: string,
): Promise<WaybillSpreadsheetResult> {
  const workbook = await loadWorkbook(filePath, originalName);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    return {
      headers: [],
      headerRow: null,
      columnMapping: {},
      drafts: [],
      warnings: ["No worksheet was found in the uploaded file."],
      rejectedRows: [],
    };
  }

  const header = findHeaderRow(sheet);
  const warnings: string[] = [];
  const rejectedRows: Array<{ row: number; reason: string }> = [];
  const missingRequired = (["buyer_tin", "item_name", "quantity", "price"] as WaybillColumn[])
    .filter((field) => !header.columnByField[field]);

  if (missingRequired.length > 0) {
    warnings.push(
      `Required columns not found: ${missingRequired.join(", ")}. Add buyer TIN, item, quantity and price columns.`,
    );
    return {
      headers: header.headers,
      headerRow: header.rowNumber,
      columnMapping: header.columnMapping,
      drafts: [],
      warnings,
      rejectedRows,
    };
  }
  if (!header.columnByField.buyer_name) warnings.push("Buyer name column was not found.");
  if (!header.columnByField.start_address) warnings.push("Start address column was not found.");
  if (!header.columnByField.end_address) warnings.push("End address column was not found.");
  if (!header.columnByField.reference) {
    warnings.push(
      "Reference/order/case column was not found. Rows will be grouped by buyer TIN, buyer name and addresses; add an order/case/document number column for safer grouping.",
    );
  }

  const draftsByKey = new Map<string, WaybillSpreadsheetDraft>();
  const startRow = (header.rowNumber ?? 0) + 1;

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber < startRow) return;

    const itemName = valueAt(row, header.columnByField, "item_name");
    const quantityText = valueAt(row, header.columnByField, "quantity");
    const priceText = valueAt(row, header.columnByField, "price");
    const buyerTin = normalizeTinText(valueAt(row, header.columnByField, "buyer_tin"));
    const buyerName = valueAt(row, header.columnByField, "buyer_name");
    const waybillTypeText = valueAt(row, header.columnByField, "waybill_type");
    const waybillType = parseWaybillType(waybillTypeText);
    const startAddress = valueAt(row, header.columnByField, "start_address");
    const endAddress = valueAt(row, header.columnByField, "end_address");
    const reference =
      valueAt(row, header.columnByField, "reference") ||
      valueAt(row, header.columnByField, "document_number");

    if (
      !itemName &&
      !quantityText &&
      !priceText &&
      !buyerTin &&
      !buyerName &&
      !reference
    ) {
      return;
    }

    const quantity = parsePositiveAmount(quantityText);
    const price = parsePositiveAmount(priceText);
    if (!itemName || quantity == null || price == null) {
      rejectedRows.push({
        row: rowNumber,
        reason: "Item name, quantity and price must all be present and greater than 0.",
      });
      return;
    }

    const key = reference
      ? `ref:${normalizeHeader(reference)}`
      : `buyer:${buyerTin}|${normalizeHeader(buyerName)}|${normalizeHeader(startAddress)}|${normalizeHeader(endAddress)}`;
    const fallbackReference = reference || `${buyerTin || "row"}-${rowNumber}`;
    let draft = draftsByKey.get(key);
    if (!draft) {
      draft = {
        reference: fallbackReference,
        waybill_type: waybillType,
        waybill_type_label: waybillTypeText || undefined,
        buyer_name: buyerName || undefined,
        buyer_tin: buyerTin || undefined,
        start_address: startAddress || undefined,
        end_address: endAddress || undefined,
        driver_name: valueAt(row, header.columnByField, "driver_name") || undefined,
        driver_tin:
          normalizeTinText(valueAt(row, header.columnByField, "driver_tin")) || undefined,
        car_number: valueAt(row, header.columnByField, "car_number") || undefined,
        document_number:
          valueAt(row, header.columnByField, "document_number") || reference || undefined,
        begin_date: valueAt(row, header.columnByField, "begin_date") || undefined,
        items: [],
        source_rows: [],
        total_amount: 0,
        warnings: [],
      };
      draftsByKey.set(key, draft);
    } else {
      mergeDraftField(draft, "buyer_name", buyerName, "Buyer name");
      mergeDraftField(draft, "buyer_tin", buyerTin, "Buyer TIN");
      if (waybillType && !draft.waybill_type) {
        draft.waybill_type = waybillType;
        draft.waybill_type_label = waybillTypeText || undefined;
      } else if (waybillType && draft.waybill_type !== waybillType) {
        draft.warnings.push(
          `Waybill type differs across grouped rows; keeping "${draft.waybill_type}".`,
        );
      }
      mergeDraftField(draft, "start_address", startAddress, "Start address");
      mergeDraftField(draft, "end_address", endAddress, "End address");
      mergeDraftField(
        draft,
        "driver_name",
        valueAt(row, header.columnByField, "driver_name"),
        "Driver name",
      );
      mergeDraftField(
        draft,
        "driver_tin",
        normalizeTinText(valueAt(row, header.columnByField, "driver_tin")),
        "Driver TIN",
      );
      mergeDraftField(
        draft,
        "car_number",
        valueAt(row, header.columnByField, "car_number"),
        "Car number",
      );
      mergeDraftField(
        draft,
        "begin_date",
        valueAt(row, header.columnByField, "begin_date"),
        "Begin date",
      );
    }

    draft.items.push({
      w_name: itemName,
      unit_txt: valueAt(row, header.columnByField, "unit_txt") || undefined,
      quantity,
      price,
      source_row: rowNumber,
    });
    draft.source_rows.push(rowNumber);
  });

  const drafts = Array.from(draftsByKey.values()).map((draft) => {
    const draftWarnings = [...draft.warnings];
    if (!draft.buyer_tin) draftWarnings.push("Buyer TIN is missing.");
    else if (!/^\d{9}(\d{2})?$/.test(draft.buyer_tin)) {
      draftWarnings.push("Buyer TIN must contain 9 or 11 digits.");
    }
    if (!draft.buyer_name) draftWarnings.push("Buyer name is missing.");
    if (!draft.start_address) draftWarnings.push("Start address is missing.");
    if (!draft.end_address) draftWarnings.push("End address is missing.");
    const total = draft.items.reduce((sum, item) => sum + item.quantity * item.price, 0);
    return {
      ...draft,
      total_amount: Math.round(total * 100) / 100,
      warnings: draftWarnings,
    };
  });

  if (rejectedRows.length > 0) {
    warnings.push(`${rejectedRows.length} rows were skipped because required item fields were invalid.`);
  }
  if (drafts.length === 0) {
    warnings.push("No valid waybill rows were found.");
  }

  return {
    headers: header.headers,
    headerRow: header.rowNumber,
    columnMapping: header.columnMapping,
    drafts,
    warnings,
    rejectedRows,
  };
}
