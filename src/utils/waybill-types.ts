export const WAYBILL_TYPES = {
  inner: 1,
  transportation: 2,
  withoutTransport: 3,
  distribution: 4,
  return: 5,
  subWaybill: 6,
} as const;

export const DEFAULT_WAYBILL_TYPE = WAYBILL_TYPES.transportation;

export const WAYBILL_TYPE_LABELS_KA: Record<number, string> = {
  [WAYBILL_TYPES.inner]: "შიდა გადაზიდვა",
  [WAYBILL_TYPES.transportation]: "ტრანსპორტირება",
  [WAYBILL_TYPES.withoutTransport]: "ტრანსპორტირების გარეშე",
  [WAYBILL_TYPES.distribution]: "დისტრიბუცია",
  [WAYBILL_TYPES.return]: "უკან დაბრუნება",
  [WAYBILL_TYPES.subWaybill]: "ქვე-ზედნადები",
};

export function normalizeWaybillType(value: unknown): number | undefined {
  const n = Number(value);
  if (Number.isInteger(n) && n >= 1 && n <= 6) return n;
  return undefined;
}

export function waybillTypeLabelKa(type: number | undefined): string {
  return type ? WAYBILL_TYPE_LABELS_KA[type] ?? `ტიპი ${type}` : "უცნობი";
}

export function inferWaybillTypeFromText(text: string): number | undefined {
  const normalized = text.toLowerCase();
  if (/sub[\s-]*waybill|child\s*waybill|\u10e5\u10d5\u10d4\s*[-\u2013\u2014]?\s*\u10d6\u10d4\u10d3\u10dc\u10d0\u10d3\u10d4\u10d1/.test(normalized)) {
    return WAYBILL_TYPES.subWaybill;
  }
  if (/უკან\s*დაბრუნ|დაბრუნებ|return/.test(normalized)) return WAYBILL_TYPES.return;
  if (/დისტრიბუც|distribution/.test(normalized)) return WAYBILL_TYPES.distribution;
  if (/ტრანსპორტირების\s*გარეშე|without\s*transport/.test(normalized)) {
    return WAYBILL_TYPES.withoutTransport;
  }
  if (/შიდა\s*გადაზიდ|inner|internal/.test(normalized)) return WAYBILL_TYPES.inner;
  if (/ტრანსპორტირებ|გადაზიდ|transport/.test(normalized)) return WAYBILL_TYPES.transportation;
  return undefined;
}

export interface WaybillValidationInput {
  type?: number;
  waybill_number?: string;
  sub_waybill_numbers?: string[];
  sub_waybills?: Array<{ waybill_number?: string }>;
  buyer_tin?: string;
  buyer_name?: string;
  start_address?: string;
  end_address?: string;
  driver_tin?: string;
  driver_name?: string;
  car_number?: string;
  items: Array<{ w_name?: string; quantity?: number; price?: number }>;
}

export function validateWaybillForRs(input: WaybillValidationInput): string[] {
  const type = normalizeWaybillType(input.type);
  const errors: string[] = [];
  const needsTransport = type !== WAYBILL_TYPES.withoutTransport;
  const needsBuyer = type !== WAYBILL_TYPES.inner;

  if (!type) errors.push("ზედნადების ტიპი არ არის არჩეული.");
  if (needsBuyer && !/^\d{9}(\d{2})?$/.test(String(input.buyer_tin ?? ""))) {
    errors.push("მყიდველის ს/კ აუცილებელია და უნდა იყოს 9 ან 11 ციფრი.");
  }
  if (needsBuyer && !input.buyer_name) errors.push("მყიდველის დასახელება აუცილებელია.");
  if (!input.start_address) errors.push("გაგზავნის მისამართი აუცილებელია.");
  if (!input.end_address) errors.push("ჩაბარების მისამართი აუცილებელია.");
  if (needsTransport && !input.car_number) {
    errors.push(`${waybillTypeLabelKa(type)} ტიპისთვის ავტომობილის ნომერი გადაამოწმეთ/შეავსეთ.`);
  }
  if (needsTransport && !input.driver_name) {
    errors.push(`${waybillTypeLabelKa(type)} ტიპისთვის მძღოლის სახელი გადაამოწმეთ/შეავსეთ.`);
  }
  if (type === WAYBILL_TYPES.return && !input.waybill_number) {
    errors.push("უკან დაბრუნების ზედნადებისთვის საწყისი/დასაბრუნებელი ზედნადების ნომერი აუცილებელია.");
  }
  const subWaybillRefs = [
    ...(input.sub_waybill_numbers ?? []),
    ...(input.sub_waybills ?? []).map((sub) => sub.waybill_number ?? ""),
  ].filter((value) => value.trim());
  if (type === WAYBILL_TYPES.subWaybill && subWaybillRefs.length === 0) {
    errors.push("ქვე-ზედნადებისთვის დაკავშირებული ზედნადების ნომერი აუცილებელია.");
  }
  if (!input.items.length) errors.push("მინიმუმ ერთი საქონლის პოზიცია აუცილებელია.");
  input.items.forEach((item, index) => {
    if (!item.w_name) errors.push(`საქონელი #${index + 1}: დასახელება აკლია.`);
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
      errors.push(`საქონელი #${index + 1}: რაოდენობა უნდა იყოს 0-ზე მეტი.`);
    }
    if (!Number.isFinite(Number(item.price)) || Number(item.price) < 0) {
      errors.push(`საქონელი #${index + 1}: ფასი არასწორია.`);
    }
  });
  return errors;
}
