import { evaluateApproval } from "./approval-gate";
import { classifyOperation } from "./classifier";
import { analyzeFinancialOperation } from "./financial-agent-stack";
import { planRsActions } from "./rs-action-planner";
import { runStructuredAgent, type StructuredAgentSpec } from "./structured-agent";
import { reasonAboutTax } from "./tax-reasoning";
import type { GeminiService } from "./gemini";

function fakeGemini(texts: string[]): GeminiService {
  const queue = [...texts];
  return {
    embed: jest.fn(),
    generateChatResponse: jest.fn(),
    generateWithTools: jest.fn(),
    validateData: jest.fn(),
    generateStructured: jest.fn(async () => ({
      text: queue.shift() ?? "{}",
      model: "gemini-test",
    })),
  };
}

describe("structured agent runner", () => {
  it("retries invalid JSON and returns validated output metadata", async () => {
    const spec: StructuredAgentSpec<{ confidence: number; warnings: string[]; value: string }> = {
      key: "test-agent",
      systemPrompt: "Return JSON.",
      maxRetries: 1,
      validate(raw) {
        if (!raw || typeof raw !== "object") throw new Error("expected object");
        return raw as { confidence: number; warnings: string[]; value: string };
      },
    };
    const gemini = fakeGemini([
      "not json",
      JSON.stringify({ value: "ok", confidence: 0.84, warnings: ["review"] }),
    ]);

    const result = await runStructuredAgent(spec, { payload: { id: 1 } }, { gemini });

    expect(result.output.value).toBe("ok");
    expect(result.confidence).toBe(0.84);
    expect(result.warnings).toEqual(["review"]);
    expect(result.attempts).toBe(2);
    expect(gemini.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("throws a structured error after all attempts fail", async () => {
    const spec: StructuredAgentSpec<{ ok: boolean }> = {
      key: "always-invalid",
      systemPrompt: "Return JSON.",
      maxRetries: 1,
      validate() {
        throw new Error("schema mismatch");
      },
    };

    await expect(
      runStructuredAgent(spec, { payload: {} }, { gemini: fakeGemini(["{}", "{}"]) }),
    ).rejects.toMatchObject({
      name: "StructuredAgentError",
      key: "always-invalid",
      attempts: 2,
    });
  });
});

describe("accounting classifier agent", () => {
  it("validates a classifier output with ledger entries", async () => {
    const result = await classifyOperation(
      { operation: { amount: 118, currency: "GEL", supplier_vat_registered: true } },
      {
        gemini: fakeGemini([
          JSON.stringify({
            category: "office_expense",
            description: "Office supplies",
            vat_applicable: true,
            vat_amount: 18,
            deductible: true,
            ledger_entries: [
              { debit: "Office Expenses", credit: "Accounts Payable", amount: 118, currency: "GEL" },
            ],
            confidence: 0.92,
            warnings: [],
          }),
        ]),
      },
    );

    expect(result.output.category).toBe("office_expense");
    expect(result.output.ledger_entries[0]).toMatchObject({ currency: "GEL" });
    expect(result.confidence).toBe(0.92);
  });
});

describe("tax reasoning agent", () => {
  it("validates tax risk and declaration effect", async () => {
    const classification = {
      category: "office_expense" as const,
      description: "Office supplies",
      vat_applicable: true,
      vat_amount: 18,
      deductible: true,
      ledger_entries: [
        { debit: "Office Expenses", credit: "Accounts Payable", amount: 118, currency: "GEL" },
      ],
      confidence: 0.92,
      warnings: [],
    };

    const result = await reasonAboutTax(
      {
        operation: { amount: 118, currency: "GEL" },
        classification,
        ragChunks: [{ content: "Input VAT may be deducted when used in taxable activity.", bookTitle: "VAT", chunkIndex: 3 }],
      },
      {
        gemini: fakeGemini([
          JSON.stringify({
            vat_status: "taxable_standard_18",
            tax_risk: "low",
            declaration_effect: "increases_input_vat",
            recommended_action: "submit_after_review",
            reasoning: "Input VAT appears deductible based on supplied context [1.3].",
            warnings: ["verify supplier VAT status"],
            confidence: 0.78,
          }),
        ]),
      },
    );

    expect(result.output.tax_risk).toBe("low");
    expect(result.output.declaration_effect).toBe("increases_input_vat");
    expect(result.warnings).toEqual(["verify supplier VAT status"]);
  });
});

describe("RS action planner agent", () => {
  it("validates ordered portal actions", async () => {
    const classification = {
      category: "sales_revenue" as const,
      description: "Service revenue",
      vat_applicable: true,
      vat_amount: 18,
      deductible: false,
      ledger_entries: [
        { debit: "Accounts Receivable", credit: "Service Revenue", amount: 118, currency: "GEL" },
      ],
      confidence: 0.94,
      warnings: [],
    };
    const taxReasoning = {
      vat_status: "taxable_standard_18" as const,
      tax_risk: "none" as const,
      declaration_effect: "increases_vat_payable" as const,
      recommended_action: "submit_now" as const,
      reasoning: "Taxable sale.",
      warnings: [],
      confidence: 0.95,
    };

    const result = await planRsActions(
      { operation: { amount: 118, currency: "GEL" }, classification, taxReasoning, countryCode: "GE" },
      {
        gemini: fakeGemini([
          JSON.stringify({
            actions: [
              {
                type: "submit_vat_invoice",
                priority: "high",
                playbook_key: "rs.ge.invoice",
                mcp_server: "rs-ge",
                mcp_tool_name: "save_invoice",
                mcp_args: {
                  invois_id: 0,
                  operation_date: "2026-05-01T00:00:00",
                },
                mcp_read_only: false,
                requires_confirmation: true,
                country_code: "GE",
                description: "Submit VAT invoice",
                required_inputs: ["seller_un_id", "buyer_un_id"],
                reversible: false,
              },
            ],
            plan_rationale: "Taxable sale should create an RS invoice.",
            warnings: [],
            confidence: 0.91,
          }),
        ]),
      },
    );

    expect(result.output.actions[0]).toMatchObject({
      type: "submit_vat_invoice",
      playbook_key: "rs.ge.invoice",
      mcp_tool_name: "save_invoice",
      requires_confirmation: true,
      reversible: false,
    });
  });
});

describe("approval gate", () => {
  it("blocks low confidence, high tax risk, and large declaration deltas", () => {
    const decision = evaluateApproval(
      { confidence: 0.72, warnings: ["missing supplier TIN"] },
      {
        amount: 5000,
        previousPeriodMedian: 1000,
        projectedDeclarationTotal: 3000,
        previousDeclarationTotal: 1000,
        taxRisk: "high",
      },
    );

    expect(decision.approved).toBe(false);
    expect(decision.flags.map((flag) => flag.kind)).toEqual(
      expect.arrayContaining(["low_confidence", "tax_risk", "unusual_amount", "declaration_delta"]),
    );
  });

  it("can auto-approve clean high-confidence outputs", () => {
    const decision = evaluateApproval(
      { confidence: 0.96, warnings: [] },
      { amount: 900, previousPeriodMedian: 1000, taxRisk: "none" },
    );

    expect(decision).toMatchObject({
      approved: true,
      summary: "Auto-approved: all checks clean.",
    });
  });

  it("blocks irreversible portal actions by default", () => {
    const decision = evaluateApproval(
      { confidence: 0.98, warnings: [] },
      { taxRisk: "none", hasIrreversibleActions: true },
    );

    expect(decision.approved).toBe(false);
    expect(decision.flags[0]).toMatchObject({ kind: "irreversible_action" });
  });
});

describe("financial agent stack", () => {
  it("runs classifier, tax reasoning, planner, and approval gate in order", async () => {
    const result = await analyzeFinancialOperation(
      {
        operation: { amount: 118, currency: "GEL", type: "sale" },
        ragChunks: [{ content: "VAT sales are taxable.", bookTitle: "VAT", chunkIndex: 1 }],
      },
      {
        gemini: fakeGemini([
          JSON.stringify({
            category: "service_revenue",
            description: "Service sale",
            vat_applicable: true,
            vat_amount: 18,
            deductible: false,
            ledger_entries: [
              { debit: "Accounts Receivable", credit: "Service Revenue", amount: 118, currency: "GEL" },
            ],
            confidence: 0.96,
            warnings: [],
          }),
          JSON.stringify({
            vat_status: "taxable_standard_18",
            tax_risk: "none",
            declaration_effect: "increases_vat_payable",
            recommended_action: "submit_now",
            reasoning: "Standard taxable sale [1.1].",
            warnings: [],
            confidence: 0.94,
          }),
          JSON.stringify({
            actions: [
              {
                type: "submit_vat_invoice",
                priority: "high",
                playbook_key: "rs.ge.invoice",
                mcp_server: "rs-ge",
                mcp_tool_name: "save_invoice",
                mcp_args: {
                  invois_id: 0,
                  operation_date: "2026-05-01T00:00:00",
                },
                mcp_read_only: false,
                requires_confirmation: true,
                country_code: "GE",
                description: "Submit invoice",
                required_inputs: ["seller_un_id", "buyer_un_id"],
                reversible: false,
              },
            ],
            plan_rationale: "Taxable sale needs invoice submission.",
            warnings: [],
            confidence: 0.93,
          }),
        ]),
      },
    );

    expect(result.summary).toMatchObject({
      confidence: 0.93,
      taxRisk: "none",
      actionCount: 1,
      mcpActionCount: 1,
      requiresConfirmation: true,
      hasIrreversibleActions: true,
    });
    expect(result.approval.approved).toBe(false);
    expect(result.approval.flags[0]).toMatchObject({ kind: "irreversible_action" });
  });
});
