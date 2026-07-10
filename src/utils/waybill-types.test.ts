import {
  inferWaybillTypeFromText,
  validateWaybillForRs,
  WAYBILL_TYPES,
} from "./waybill-types";

const base = {
  buyer_tin: "123456789",
  buyer_name: "Buyer LLC",
  start_address: "Tbilisi",
  end_address: "Batumi",
  driver_name: "Driver",
  car_number: "AA123AA",
  items: [{ w_name: "Coffee", quantity: 1, price: 10 }],
};

describe("waybill type helpers", () => {
  it("infers all supported textual waybill types", () => {
    expect(inferWaybillTypeFromText("internal transfer")).toBe(WAYBILL_TYPES.inner);
    expect(inferWaybillTypeFromText("transportation")).toBe(WAYBILL_TYPES.transportation);
    expect(inferWaybillTypeFromText("without transport")).toBe(WAYBILL_TYPES.withoutTransport);
    expect(inferWaybillTypeFromText("distribution")).toBe(WAYBILL_TYPES.distribution);
    expect(inferWaybillTypeFromText("return")).toBe(WAYBILL_TYPES.return);
    expect(inferWaybillTypeFromText("sub-waybill")).toBe(WAYBILL_TYPES.subWaybill);
    expect(inferWaybillTypeFromText("ქვე-ზედნადები")).toBe(WAYBILL_TYPES.subWaybill);
  });

  it("does not require a buyer for inner waybills", () => {
    expect(
      validateWaybillForRs({
        ...base,
        type: WAYBILL_TYPES.inner,
        buyer_tin: undefined,
        buyer_name: undefined,
      }),
    ).toEqual([]);
  });

  it("does not require a start address (the company default fills it at send time)", () => {
    expect(
      validateWaybillForRs({ ...base, type: WAYBILL_TYPES.transportation, start_address: undefined }),
    ).toEqual([]);
    // end address still required — it is per-shipment, not a fixed company value
    expect(
      validateWaybillForRs({ ...base, type: WAYBILL_TYPES.transportation, end_address: undefined }),
    ).toEqual(expect.arrayContaining([expect.stringContaining("ჩაბარების")]));
  });

  it("does not require driver or car for without-transport waybills", () => {
    expect(
      validateWaybillForRs({
        ...base,
        type: WAYBILL_TYPES.withoutTransport,
        driver_name: undefined,
        car_number: undefined,
      }),
    ).toEqual([]);
  });

  it("requires source refs for return and sub-waybill types", () => {
    expect(validateWaybillForRs({ ...base, type: WAYBILL_TYPES.return })).toEqual(
      expect.arrayContaining([expect.stringContaining("საწყისი")]),
    );
    expect(
      validateWaybillForRs({
        ...base,
        type: WAYBILL_TYPES.return,
        waybill_number: "WB-123",
      }),
    ).toEqual([]);

    expect(validateWaybillForRs({ ...base, type: WAYBILL_TYPES.subWaybill })).toEqual(
      expect.arrayContaining([expect.stringContaining("დაკავშირებული")]),
    );
    expect(
      validateWaybillForRs({
        ...base,
        type: WAYBILL_TYPES.subWaybill,
        sub_waybill_numbers: ["WB-1", "WB-2"],
      }),
    ).toEqual([]);
  });
});
