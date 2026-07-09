import { dispatchTool } from "./chat-tools";
import { rsServerClient } from "./rs-server-client";

describe("chat payroll tools", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("prepares payroll without filing on the first call", async () => {
    const post = jest.spyOn(rsServerClient, "post").mockResolvedValue({
      payroll_run_id: "payroll-1",
      approval: {
        id: "approval-1",
        snapshot_hash: "hash-1",
      },
      snapshot: {
        period_year: 2026,
        period_month: 5,
        employee_count: 2,
        total_gross: 3000,
        total_income_tax: 600,
      },
    });

    const result = (await dispatchTool(
      "file_payroll",
      { year: 2026, month: 5 },
      { companyId: "co-1", userId: "user-1" },
    )) as Record<string, unknown>;

    expect(result.requiresConfirmation).toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/internal/tools/payroll/prepare",
      expect.objectContaining({
        companyId: "co-1",
        userId: "user-1",
        body: { year: 2026, month: 5 },
      }),
    );
  });

  it("dispatches payroll filing only when confirm is explicitly true", async () => {
    const post = jest.spyOn(rsServerClient, "post").mockResolvedValue({
      payroll_run_id: "payroll-1",
      submit: { submission_status: "dispatched" },
    });

    await dispatchTool(
      "file_payroll",
      {
        year: 2026,
        month: 5,
        confirm: true,
        payroll_run_id: "payroll-1",
        approval_id: "approval-1",
        snapshot_hash: "hash-1",
      },
      { companyId: "co-1" },
    );

    expect(post).toHaveBeenCalledWith(
      "/internal/tools/payroll/file",
      expect.objectContaining({
        companyId: "co-1",
        body: {
          payroll_run_id: "payroll-1",
          approval_id: "approval-1",
          snapshot_hash: "hash-1",
        },
      }),
    );
  });
});

describe("chat invoice tools", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("requires preview order ids before confirming invoice issuance", async () => {
    const post = jest.spyOn(rsServerClient, "post").mockResolvedValue({});

    const result = (await dispatchTool(
      "upload_invoices_for_date",
      { date: "2026-06-10", confirm: true },
      { companyId: "co-1", userId: "user-1" },
    )) as Record<string, unknown>;

    expect(String(result.error)).toContain("confirmation_order_ids");
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects fractional invoice action parameters at the chat boundary", async () => {
    const post = jest.spyOn(rsServerClient, "post").mockResolvedValue({});

    const result = (await dispatchTool(
      "accept_invoice",
      { invoiceId: 123.5, status: 2 },
      { companyId: "co-1", userId: "user-1" },
    )) as Record<string, unknown>;

    expect(String(result.error)).toContain("integer");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("chat waybill tools", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("requires preview order ids before confirming waybill upload", async () => {
    const post = jest.spyOn(rsServerClient, "post").mockResolvedValue({});

    const result = (await dispatchTool(
      "upload_waybills_for_date",
      { date: "2026-06-10", confirm: true },
      { companyId: "co-1", userId: "user-1" },
    )) as Record<string, unknown>;

    expect(String(result.error)).toContain("confirmation_order_ids");
    expect(post).not.toHaveBeenCalled();
  });
});
