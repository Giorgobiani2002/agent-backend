import request from "supertest";
import { app } from "../index";
import * as booksRepository from "../repositories/books";
import * as agentRunsRepository from "../repositories/agentRuns";
import { geminiService } from "../services/gemini";
import { withTenant } from "../test-utils";
import {
  assertReviewedPlaybook,
  normalizeAllowedDomains,
  normalizeSessionKey,
  scoreTaskAgainstPlaybook,
} from "./agent";

jest.mock("../repositories/books");
jest.mock("../repositories/agentRuns");

describe("agent routes", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.mocked(booksRepository.searchBookChunksWithNeighbors).mockResolvedValue([
      {
        id: "chunk-1",
        book_id: "book-1",
        chunk_index: 3,
        content: "Expanded context",
        token_count: 2,
        char_count: 16,
        metadata: { screenshotUrl: "https://example.test/frame.jpg", startTime: 12 },
        book_title: "VAT Guide",
        book_metadata: { source: "youtube_video", createdAt: "now" },
        rank: 1,
        similarity: 0.91,
      },
    ]);
    jest.mocked(booksRepository.searchBookChunks).mockResolvedValue([
      {
        id: "chunk-1",
        book_id: "book-1",
        chunk_index: 3,
        content: "Georgian VAT sales are taxable.",
        token_count: 5,
        char_count: 32,
        metadata: {},
        book_title: "VAT Guide",
        book_metadata: {},
        rank: 1,
        similarity: 0.91,
      },
    ]);
    jest
      .mocked(agentRunsRepository.insertAgentRun)
      .mockResolvedValue({ id: "run-stub-1" } as never);
    jest
      .mocked(agentRunsRepository.medianAmountByCategory)
      .mockResolvedValue(null);
    jest.mocked(agentRunsRepository.listAgentRuns).mockResolvedValue([]);
    jest.mocked(agentRunsRepository.getAgentRunById).mockResolvedValue(null);
    jest
      .mocked(agentRunsRepository.decideAgentRun)
      .mockResolvedValue(null);
  });

  it("returns expanded context with source metadata", async () => {
    jest.spyOn(geminiService, "embed").mockResolvedValue(new Array(1536).fill(0.2));

    const response = await withTenant(request(app).get("/agent/context")).query({
      task: "VAT declaration",
      limit: "4",
    });

    expect(response.status).toBe(200);
    // Books are global — no companyId argument here.
    expect(booksRepository.searchBookChunksWithNeighbors).toHaveBeenCalledWith(
      expect.any(Array),
      4,
      expect.any(Number),
      expect.any(Number),
      undefined,
    );
    expect(response.body.context).toMatchObject({
      seedLimit: 4,
      chunksReturned: 1,
    });
    expect(response.body.chunks[0]).toMatchObject({
      book_title: "VAT Guide",
      metadata: expect.objectContaining({ screenshotUrl: "https://example.test/frame.jpg" }),
    });
  });

  it("normalizes free-mode browser policy defaults", () => {
    expect(normalizeAllowedDomains(undefined)).toEqual(["rs.ge"]);
    expect(normalizeAllowedDomains(["https://rs.ge/foo", " RS.GE "])).toEqual(["rs.ge"]);
    expect(normalizeSessionKey("Main User!")).toBe("main_user");
  });

  it("requires automation playbooks to be ready, reviewed, and non-empty", () => {
    expect(() =>
      assertReviewedPlaybook({
        id: "playbook-1",
        status: "ready",
        review_status: "reviewed",
        steps: [{ action: "click" }],
      }),
    ).not.toThrow();

    expect(() =>
      assertReviewedPlaybook({
        id: "playbook-2",
        status: "ready",
        review_status: "pending_review",
        steps: [{ action: "click" }],
      }),
    ).toThrow("reviewed");

    expect(() =>
      assertReviewedPlaybook({
        id: "playbook-3",
        status: "ready",
        review_status: "reviewed",
        steps: [],
      }),
    ).toThrow("at least one");
  });

  it("boosts rs.ge playbook matches for portal-specific tasks", () => {
    const score = scoreTaskAgainstPlaybook("open VAT declaration on rs.ge", {
      name: "VAT declaration",
      steps: [
        { action: "navigate", url: "https://eservices.rs.ge" },
        { action: "click", target_description: "VAT declarations" },
      ],
    });

    expect(score).toBeGreaterThanOrEqual(0.35);
  });

  it("returns an end-to-end structured financial plan", async () => {
    jest.spyOn(geminiService, "embed").mockResolvedValue(new Array(1536).fill(0.2));
    jest.spyOn(geminiService, "generateStructured")
      .mockResolvedValueOnce({
        text: JSON.stringify({
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
        model: "gemini-test",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          vat_status: "taxable_standard_18",
          tax_risk: "none",
          declaration_effect: "increases_vat_payable",
          recommended_action: "submit_now",
          reasoning: "Standard taxable sale [1.3].",
          warnings: [],
          confidence: 0.94,
        }),
        model: "gemini-test",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
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
        model: "gemini-test",
      });

    const response = await withTenant(request(app).post("/agent/financial-plan")).send({
      operation: { amount: 118, currency: "GEL", type: "sale" },
      taskHint: "B2B service sale",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      knowledge_chunks_used: 1,
      result: {
        summary: {
          approved: false,
          confidence: 0.93,
          taxRisk: "none",
          actionCount: 1,
          mcpActionCount: 1,
          requiresConfirmation: true,
          hasIrreversibleActions: true,
        },
      },
    });
    expect(response.body.result.actionPlan.output.actions[0]).toMatchObject({
      mcp_server: "rs-ge",
      mcp_tool_name: "save_invoice",
      requires_confirmation: true,
    });
    expect(response.body.result.approval.flags[0]).toMatchObject({
      kind: "irreversible_action",
    });
    expect(booksRepository.searchBookChunks).toHaveBeenCalledWith(expect.any(Array), 12);
    expect(response.body.run_id).toBe("run-stub-1");
    expect(agentRunsRepository.insertAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 118,
        currency: "GEL",
      }),
    );
    expect(agentRunsRepository.medianAmountByCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "service_revenue",
        currency: "GEL",
      }),
    );
  });

  it("re-evaluates approval with looked-up median when none was supplied", async () => {
    jest.spyOn(geminiService, "embed").mockResolvedValue(new Array(1536).fill(0.2));
    // Three clean agent outputs — all high confidence, no risk, no
    // irreversible action — so the only thing that could flip approval
    // is the unusual-amount rule once the median comes from history.
    jest.spyOn(geminiService, "generateStructured")
      .mockResolvedValueOnce({
        text: JSON.stringify({
          category: "office_expense",
          description: "Office supplies",
          vat_applicable: true,
          vat_amount: 18,
          deductible: true,
          ledger_entries: [
            { debit: "Office Expenses", credit: "Accounts Payable", amount: 5000, currency: "GEL" },
          ],
          confidence: 0.97,
          warnings: [],
        }),
        model: "gemini-test",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          vat_status: "taxable_standard_18",
          tax_risk: "none",
          declaration_effect: "increases_input_vat",
          recommended_action: "submit_now",
          reasoning: "Standard deductible expense.",
          warnings: [],
          confidence: 0.96,
        }),
        model: "gemini-test",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          actions: [
            {
              type: "update_purchase_ledger",
              priority: "high",
              playbook_key: "rs.ge.invoice",
              mcp_server: "none",
              mcp_tool_name: "none",
              mcp_args: {},
              mcp_read_only: false,
              requires_confirmation: false,
              country_code: "GE",
              description: "Record expense",
              required_inputs: [],
              reversible: true,
            },
          ],
          plan_rationale: "Pure ledger update.",
          warnings: [],
          confidence: 0.95,
        }),
        model: "gemini-test",
      });

    jest
      .mocked(agentRunsRepository.medianAmountByCategory)
      .mockResolvedValue(1000);

    const response = await withTenant(request(app).post("/agent/financial-plan")).send({
      operation: { amount: 5000, currency: "GEL" },
    });

    expect(response.status).toBe(200);
    expect(agentRunsRepository.medianAmountByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ category: "office_expense", currency: "GEL" }),
    );
    expect(response.body.result.summary.approved).toBe(false);
    expect(
      response.body.result.approval.flags.map((f: { kind: string }) => f.kind),
    ).toContain("unusual_amount");
  });

  it("lists pending agent runs for the company", async () => {
    jest.mocked(agentRunsRepository.listAgentRuns).mockResolvedValue([
      { id: "r1", status: "pending_review", category: "office_expense" } as never,
    ]);
    const response = await withTenant(
      request(app).get("/agent/financial-plans"),
    ).query({ status: "pending_review" });
    expect(response.status).toBe(200);
    expect(response.body.runs).toHaveLength(1);
    expect(agentRunsRepository.listAgentRuns).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending_review" }),
    );
  });

  it("records a human decision on an agent run", async () => {
    jest.mocked(agentRunsRepository.decideAgentRun).mockResolvedValue({
      id: "r1",
      status: "approved",
    } as never);
    const response = await withTenant(
      request(app).post("/agent/financial-plans/r1/decision"),
    ).send({ decision: "approved", note: "Looks fine" });
    expect(response.status).toBe(200);
    expect(agentRunsRepository.decideAgentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "r1",
        decision: "approved",
        reviewNote: "Looks fine",
      }),
    );
  });

  it("rejects invalid decision values on agent runs", async () => {
    const response = await withTenant(
      request(app).post("/agent/financial-plans/r1/decision"),
    ).send({ decision: "lgtm" });
    expect(response.status).toBe(400);
  });
});
