import type { FunctionDeclaration } from "@google/genai";
import { query } from "../db";
import {
  getAlertById,
  listAlerts,
  setAlertStatus,
  type AlertStatus,
} from "../repositories/alerts";
import { listFailurePatterns } from "../repositories/failurePatterns";
import {
  findBulkRun,
  listBulkRuns,
  requeueRowForRetry,
  resetIncompleteRows,
  skipBulkRow,
} from "../repositories/bulkRuns";
import { runWriteTool, type WriteToolOutcome } from "./chat-write-tools";
import { classifyErrorText } from "./alert-generator";
import {
  findPlaybookById,
  listPlaybooks,
} from "../repositories/playbooks";
import {
  getAgentRunById,
  listAgentRuns,
  type AgentRunStatus,
} from "../repositories/agentRuns";
import {
  findScheduledRunById,
  listScheduledRuns,
} from "../repositories/scheduledRuns";
import { rsServerClient, RsServerClientError } from "./rs-server-client";

/**
 * Chat-tool registry (Slice A — read-only).
 *
 * Each tool is exposed to Gemini as a `FunctionDeclaration` and dispatched
 * here against either the agent-backend Postgres (bulk runs, playbooks,
 * agent runs, schedules, failure patterns) or rs-server's internal API
 * (waybills, declarations, pipeline runs, orders, integrations).
 *
 * Conventions:
 *   - Every tool is tenant-scoped via the `companyId` arg the dispatcher
 *     receives from chat. Tools never accept a company_id parameter from
 *     the model — that would be a cross-tenant leak.
 *   - Tools return plain JSON-serializable objects; never throw raw
 *     errors. Errors are converted to `{ error: string }` so the model
 *     can keep going (e.g. apologise to the user) instead of aborting
 *     the loop with an exception.
 *   - Parameter schemas use the same JSON-schema-ish shape Gemini
 *     accepts: `type`, `properties`, `required`. Keep them minimal —
 *     descriptions matter more than constraints for model accuracy.
 */

export interface ToolCallContext {
  companyId: string;
  userId?: string;
}

export type ToolHandler = (
  ctx: ToolCallContext,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function int(v: unknown): number | undefined {
  const n = num(v);
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

async function safeRsGet<T>(
  path: string,
  ctx: ToolCallContext,
  query?: Record<string, string | number | undefined>,
): Promise<T | { error: string }> {
  try {
    return await rsServerClient.get<T>(path, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      query,
    });
  } catch (err) {
    if (err instanceof RsServerClientError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function safeRsPost<T>(
  path: string,
  ctx: ToolCallContext,
  body?: Record<string, unknown>,
): Promise<T | { error: string }> {
  try {
    return await rsServerClient.post<T>(path, {
      companyId: ctx.companyId,
      userId: ctx.userId,
      body: body ?? {},
    });
  } catch (err) {
    if (err instanceof RsServerClientError) {
      return { error: err.message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Tool catalog ────────────────────────────────────────────────────────

export const CHAT_TOOLS: ChatTool[] = [
  // rs-server reads ──
  {
    name: "get_waybill",
    description:
      "Look up a single waybill belonging to the current company. Accepts either the internal waybill id (UUID) or the numeric rs.ge waybill id.",
    parameters: {
      type: "object",
      properties: {
        waybillId: { type: "string", description: "internal UUID or rs.ge numeric id" },
      },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const id = str(args.waybillId);
      if (!id) return { error: "waybillId is required" };
      return safeRsGet(`/internal/tools/waybills/${encodeURIComponent(id)}`, ctx);
    },
  },
  {
    name: "search_waybills",
    description:
      "List the company's most recent waybills, newest first. Supports filtering by rs.ge status code or by orderId.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", description: "rs.ge numeric status (e.g. '0','1','-1')" },
        orderId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/waybills`, ctx, {
        status: str(args.status),
        orderId: str(args.orderId),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "get_declaration",
    description:
      "Look up a single declaration by its internal id. Returns the full record including the tax-authority response (rsge_response).",
    parameters: {
      type: "object",
      properties: { declarationId: { type: "string" } },
      required: ["declarationId"],
    },
    async handler(ctx, args) {
      const id = str(args.declarationId);
      if (!id) return { error: "declarationId is required" };
      return safeRsGet(
        `/internal/tools/declarations/${encodeURIComponent(id)}`,
        ctx,
      );
    },
  },
  {
    name: "list_declarations",
    description:
      "List the company's recent declarations, newest first. Use status='rejected' or status='submitted' to filter by lifecycle state.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "submitted", "approved", "rejected"] },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/declarations`, ctx, {
        status: str(args.status),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "get_taxpayer_info",
    description:
      "Look up a Georgian taxpayer's public info on rs.ge by TIN (საიდენტიფიკაციო კოდი) — name, legal form, status and VAT registration. Use to verify a buyer/counterparty before issuing a waybill or invoice, or to check the company's own standing.",
    parameters: {
      type: "object",
      properties: {
        tin: {
          type: "string",
          description: "taxpayer identification code (TIN / საიდენტიფიკაციო კოდი)",
        },
      },
      required: ["tin"],
    },
    async handler(ctx, args) {
      const tin = str(args.tin);
      if (!tin) return { error: "tin is required" };
      return safeRsGet(`/internal/tools/taxpayer/info`, ctx, { tin });
    },
  },
  {
    name: "check_submission_eligibility",
    description:
      "Check whether the company is eligible to file BEFORE submitting — verifies rs.ge taxpayer status, VAT registration and tax debt (a debt ≥ 50,000 GEL triggers the special invoice rule, N3751). Returns a verdict (pass/warn/block) with reasons. Use before filing a VAT return or issuing invoices, or when the user asks 'can we file' / wants to pre-empt a rejection.",
    parameters: {
      type: "object",
      properties: {
        docType: {
          type: "string",
          enum: ["vat", "invoice", "waybill"],
          description: "what is about to be filed; defaults to vat",
        },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/taxpayer/eligibility`, ctx, {
        docType: str(args.docType),
      });
    },
  },
  {
    name: "draft_vat_return",
    description:
      "Draft and explain the company's monthly VAT (დღგ) return for a period. Computes output VAT (from sales invoices), input VAT (from ACCEPTED purchase invoices) and net VAT payable from the invoices synced to declario, returning totals, invoice counts, sample invoice ids and warnings. Use when the user asks to prepare/draft/explain their VAT for a month. The Georgian VAT rate is 18%. IMPORTANT: rs.ge has NO declaration API — this only DRAFTS the figures; the actual return is filed in the rs.ge UI. Ground the explanation in the Tax Code articles from the knowledge base and surface any warnings (e.g. input VAT not synced).",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year, e.g. 2026; defaults to the current period" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to the current period" },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/vat-preview`, ctx, {
        year: num(args.year),
        month: num(args.month),
      });
    },
  },
  {
    name: "draft_payroll",
    description:
      "Draft and explain THE COMPANY'S OWN payroll for a period from declario's employee records — per employee gross, income tax (20%), pension (2% employee + 2% employer) and net, plus totals and employer cost. Use for any 'our/my payroll', 'ხელფასები დამიდგინე/გამოთვალე', 'how much salary tax do we owe' request, and base every number on the tool result. rs.ge has NO payroll API — this DRAFTS only; filing is a separate step.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year; defaults to current" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to current" },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/payroll-preview`, ctx, {
        year: num(args.year),
        month: num(args.month),
      });
    },
  },
  {
    name: "draft_profit_tax",
    description:
      "Compute the company's monthly profit tax (მოგების გადასახადი, Estonian model: CIT 15%, gross-up amount×15/85) for distribution events the user names in the conversation — dividends paid (distributed_profit), non-business expenses (non_business_expense), free supplies (free_supply), representation expenses over the limit (representation_over_limit). Extract each event's NET amount from the user's message into lines. Use for 'მოგების გადასახადი დამითვალე', 'გავანაწილე დივიდენდი X — რა გადასახადია'. Returns per-line tax + totals + warnings. Drafting only — filing is separate.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year; defaults to current" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to current" },
        lines: {
          type: "array",
          description: "distribution events from the conversation",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "distributed_profit",
                  "non_business_expense",
                  "free_supply",
                  "representation_over_limit",
                ],
              },
              amount: { type: "number", description: "net amount in GEL" },
            },
            required: ["type", "amount"],
          },
        },
      },
      required: ["lines"],
    },
    async handler(ctx, args) {
      const lines = Array.isArray(args.lines) ? (args.lines as any[]) : [];
      if (!lines.length) return { error: "lines is required — name at least one distribution event" };
      return safeRsPost(`/internal/tools/profit-tax/preview`, ctx, {
        year: num(args.year),
        month: num(args.month),
        lines: lines.map((l) => ({ type: str(l?.type), amount: num(l?.amount) ?? 0 })),
      });
    },
  },
  {
    name: "audit_vat_submission",
    description:
      "Audit/verify whether the company's VAT (დღგ) declaration for a period is correct: compares the prepared/submitted figures against a fresh recompute from current invoices and returns any discrepancies (field, declared vs recomputed, delta) plus the submission status. Use whenever the user asks to CHECK/VERIFY their already-prepared or submitted/uploaded VAT ('გადაამოწმე ჩემი ატვირთული დღგ', 'is my submitted VAT correct', 'ეს დეკლარაცია სწორია?'). Read-only. Explain any discrepancies and cite the relevant Tax Code rule.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year; defaults to current" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to current" },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/audit-vat`, ctx, {
        year: num(args.year),
        month: num(args.month),
      });
    },
  },
  {
    name: "import_employees",
    description:
      "Add or update the company's employees and their MONTHLY GROSS salaries from a list the user gives — pasted text (e.g. 'ნინო 2000, გია 1500') or a salary sheet you have parsed. Each item: { name, gross (monthly gross in GEL), personal_id? (11-digit Georgian ID), pension_participant? }. Upserts by personal_id or name (re-importing updates in place). Use when the user says e.g. 'ამ თანამშრომლების ხელფასები ამიტვირთე/დაამატე'. After importing, offer to call draft_payroll to compute the payroll.",
    parameters: {
      type: "object",
      properties: {
        employees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              gross: { type: "number", description: "monthly gross salary in GEL" },
              personal_id: { type: "string", description: "11-digit Georgian personal number (optional)" },
              pension_participant: { type: "boolean" },
            },
            required: ["name", "gross"],
          },
        },
      },
      required: ["employees"],
    },
    async handler(ctx, args) {
      const list = Array.isArray(args.employees) ? (args.employees as any[]) : [];
      if (!list.length) return { error: "employees list is required" };
      const employees = list.map((e) => ({
        name: str(e?.name),
        gross_salary: num(e?.gross) ?? num(e?.gross_salary) ?? 0,
        personal_id: str(e?.personal_id),
        pension_participant: e?.pension_participant !== false,
      }));
      return safeRsPost(`/internal/tools/payroll/employees/bulk`, ctx, { employees });
    },
  },
  {
    name: "file_payroll",
    description:
      "Prepare AND upload/file the company's monthly payroll declaration on rs.ge from declario's employee records. Use when the user says 'ხელფასები ამიტვირთე/გააგზავნე/დააფიქსირე' for a period and means filing, not merely importing an employee list. STRICT TWO-STEP SAFETY: (1) call without confirm to prepare the payroll run and return employee count, gross, income tax, pension, net and warnings; show that exact preview and ask for explicit approval. (2) Call again with confirm=true only after the user clearly approves this specific period and totals in the conversation. Never auto-confirm. The browser playbook runs halt-on-dangerous, fills rs.ge and pauses before the final irreversible submit.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "payroll period year; defaults to current" },
        month: {
          type: "integer",
          minimum: 1,
          maximum: 12,
          description: "payroll period month 1-12; defaults to current",
        },
        confirm: {
          type: "boolean",
          description:
            "Set true only after the user explicitly approves filing this exact payroll preview. Omit/false to prepare only.",
        },
        payroll_run_id: {
          type: "string",
          description: "Required with confirm=true; returned by the prepare step.",
        },
        approval_id: {
          type: "string",
          description: "Required with confirm=true; returned by the prepare step.",
        },
        snapshot_hash: {
          type: "string",
          description: "Required with confirm=true; returned by the prepare step approval.",
        },
      },
    },
    async handler(ctx, args) {
      const year = num(args.year);
      const month = num(args.month);
      if (args.confirm === true) {
        const payrollRunId = str(args.payroll_run_id);
        const approvalId = str(args.approval_id);
        const snapshotHash = str(args.snapshot_hash);
        if (!payrollRunId || !approvalId || !snapshotHash) {
          return {
            error:
              "payroll_run_id, approval_id and snapshot_hash from the prepared preview are required",
          };
        }
        return safeRsPost(`/internal/tools/payroll/file`, ctx, {
          payroll_run_id: payrollRunId,
          approval_id: approvalId,
          snapshot_hash: snapshotHash,
        });
      }
      const prepared = await safeRsPost(`/internal/tools/payroll/prepare`, ctx, {
        year,
        month,
      });
      return {
        requiresConfirmation: true,
        prepared,
        note: "Payroll prepared but NOT filed. Show the exact period, totals, employee count, warnings and approval expiry; ask the user to approve before calling file_payroll with confirm=true and the returned payroll_run_id, approval.id and approval.snapshot_hash.",
      };
    },
  },
  {
    name: "file_vat_return",
    description:
      "Prepare AND file the company's VAT (დღგ) declaration for a period on rs.ge. Use when the user asks to FILE/submit/'დააფიქსირე/გააგზავნე' their VAT. TWO-STEP SAFETY PROTOCOL: (1) call WITHOUT confirm first — it prepares the draft and returns the figures; show them and ask the user to explicitly approve filing THIS declaration. (2) Call again with confirm=true ONLY AFTER the user clearly says yes in this conversation. NEVER set confirm=true on your own. Filing dispatches the rs.ge browser playbook in halt-on-dangerous mode (it fills the form and stops before the final submit for the user to finalize), so nothing is submitted silently.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year; defaults to current" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to current" },
        confirm: {
          type: "boolean",
          description:
            "Set true ONLY after the user has explicitly approved filing this specific declaration in the conversation. Omit/false to just prepare and ask for confirmation.",
        },
        declaration_id: {
          type: "string",
          description: "Required when confirm=true. Use the declaration_id returned by the prepare step.",
        },
        approval_id: {
          type: "string",
          description: "Required when confirm=true. Use prepared.approval.id from the prepare step.",
        },
        snapshot_hash: {
          type: "string",
          description: "Required when confirm=true. Use prepared.approval.snapshot_hash from the prepare step.",
        },
      },
    },
    async handler(ctx, args) {
      const year = num(args.year);
      const month = num(args.month);
      if (args.confirm === true) {
        const declarationId = str(args.declaration_id);
        const approvalId = str(args.approval_id);
        const snapshotHash = str(args.snapshot_hash);
        if (!declarationId || !approvalId || !snapshotHash) {
          return {
            error:
              "confirm=true requires declaration_id, approval_id and snapshot_hash from the prepare result",
            requiresConfirmation: true,
          };
        }
        return safeRsPost(`/internal/tools/declarations/file`, ctx, {
          declaration_id: declarationId,
          approval_id: approvalId,
          snapshot_hash: snapshotHash,
          safety_mode: "halt-on-dangerous",
        });
      }
      const prepared = await safeRsPost(`/internal/tools/declarations/prepare`, ctx, {
        year,
        month,
      });
      return {
        requiresConfirmation: true,
        prepared,
        note: "Draft prepared but NOT filed. Show the figures and ask the user to confirm; only then call file_vat_return again with confirm=true and the returned declaration_id, approval.id and approval.snapshot_hash.",
      };
    },
  },
  {
    name: "preview_waybills_from_orders",
    description:
      "Preview the waybills (ზედნადები) that can be built from the company's orders for a date WITHOUT sending anything to rs.ge. Returns each buildable waybill (buyer, goods count, amount, warnings), existing drafts an upload would send, which orders are already sent, and totals. Use for a no-send dry run.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD; orders are matched by their created date (UTC day)",
        },
        orderIds: {
          type: "array",
          items: { type: "string" },
          description: "optional explicit order ids instead of a whole day",
        },
      },
    },
    async handler(ctx, args) {
      const date = str(args.date);
      const orderIds = Array.isArray(args.orderIds)
        ? (args.orderIds as unknown[])
            .map((x) => str(x))
            .filter((x): x is string => Boolean(x))
        : undefined;
      if (!date && (!orderIds || orderIds.length === 0)) {
        return { error: "Provide a date (YYYY-MM-DD) or orderIds" };
      }
      return safeRsGet(`/internal/tools/waybills/preview-from-orders`, ctx, {
        date,
        orderIds: orderIds?.join(","),
      });
    },
  },
  {
    name: "upload_waybills_for_date",
    description:
      "Create AND send waybills (ზედნადები) to rs.ge from the company's orders for a date ('ატვირთე/გააგზავნე ზედნადები [date]-ის შეკვეთებზე'). STRICT TWO-STEP SAFETY: (1) call WITHOUT confirm — it returns the buildable-waybill preview (per order: buyer, goods, amount, warnings), existing drafts that will be sent, orders already sent, totals, and confirmation_order_ids; show this and ask the user to approve sending. (2) Call again with confirm=true ONLY after the user explicitly approves in this conversation, passing orderIds copied from confirmation_order_ids so the sent set exactly matches the preview. Sending is IRREVERSIBLE on rs.ge. Never set confirm=true on your own. Safe to re-run: already-sent orders are skipped and existing drafts are sent, not duplicated.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD; orders are matched by their created date (UTC day)",
        },
        orderIds: {
          type: "array",
          items: { type: "string" },
          description: "optional explicit order ids instead of a whole day",
        },
        confirm: {
          type: "boolean",
          description:
            "true ONLY after the user explicitly approves sending this exact preview. Omit/false to preview only.",
        },
      },
    },
    async handler(ctx, args) {
      const date = str(args.date);
      const orderIds = Array.isArray(args.orderIds)
        ? (args.orderIds as unknown[])
            .map((x) => str(x))
            .filter((x): x is string => Boolean(x))
        : undefined;
      if (!date && (!orderIds || orderIds.length === 0)) {
        return { error: "Provide a date (YYYY-MM-DD) or orderIds" };
      }
      if (args.confirm === true) {
        if (!orderIds || orderIds.length === 0) {
          return {
            error:
              "confirmation_order_ids are required before confirm=true. Preview first, then pass prepared.confirmation_order_ids as orderIds.",
          };
        }
        return safeRsPost(`/internal/tools/waybills/upload-from-orders`, ctx, {
          date,
          orderIds,
        });
      }
      const prepared = await safeRsGet(
        `/internal/tools/waybills/preview-from-orders`,
        ctx,
        { date, orderIds: orderIds?.join(",") },
      );
      return {
        requiresConfirmation: true,
        prepared,
        note: "Waybills built but NOT sent. Show the buyers, goods, amounts, totals and any warnings; note which orders are skipped (already sent) and which existing drafts will be sent. If the user explicitly approves, call upload_waybills_for_date again with confirm=true and pass orderIds from prepared.confirmation_order_ids; never confirm by date alone.",
      };
    },
  },
  {
    name: "send_waybill",
    description:
      "Send/activate ONE already-created waybill on rs.ge by its numeric rs.ge waybill id. IRREVERSIBLE — queues for human approval unless the gate clears it. For a whole day of orders use upload_waybills_for_date instead.",
    parameters: {
      type: "object",
      properties: { waybillId: { type: "integer", description: "numeric rs.ge waybill id" } },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const waybillId = num(args.waybillId);
      if (typeof waybillId !== "number") {
        return { error: "waybillId (numeric rs.ge id) is required" };
      }
      return runWriteTool(
        {
          name: "send_waybill",
          describe: (a) => `send waybill ${a.waybillId} to rs.ge`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/waybills/${a.waybillId}/send`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { waybillId },
        ctx,
      );
    },
  },
  {
    name: "confirm_waybill",
    description:
      "Confirm receipt of a waybill on rs.ge (buyer side) by its numeric rs.ge waybill id. IRREVERSIBLE — queues for human approval unless the gate clears it.",
    parameters: {
      type: "object",
      properties: { waybillId: { type: "integer", description: "numeric rs.ge waybill id" } },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const waybillId = num(args.waybillId);
      if (typeof waybillId !== "number") {
        return { error: "waybillId (numeric rs.ge id) is required" };
      }
      return runWriteTool(
        {
          name: "confirm_waybill",
          describe: (a) => `confirm receipt of waybill ${a.waybillId}`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/waybills/${a.waybillId}/confirm`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { waybillId },
        ctx,
      );
    },
  },
  {
    name: "reject_waybill",
    description:
      "Reject a waybill on rs.ge (buyer side) by its numeric rs.ge waybill id. IRREVERSIBLE — queues for human approval unless the gate clears it.",
    parameters: {
      type: "object",
      properties: { waybillId: { type: "integer", description: "numeric rs.ge waybill id" } },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const waybillId = num(args.waybillId);
      if (typeof waybillId !== "number") {
        return { error: "waybillId (numeric rs.ge id) is required" };
      }
      return runWriteTool(
        {
          name: "reject_waybill",
          describe: (a) => `reject waybill ${a.waybillId}`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/waybills/${a.waybillId}/reject`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { waybillId },
        ctx,
      );
    },
  },
  {
    name: "close_waybill",
    description:
      "Close/finalize a waybill on rs.ge (mark delivery complete) by its numeric rs.ge waybill id. IRREVERSIBLE — queues for human approval unless the gate clears it.",
    parameters: {
      type: "object",
      properties: { waybillId: { type: "integer", description: "numeric rs.ge waybill id" } },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const waybillId = num(args.waybillId);
      if (typeof waybillId !== "number") {
        return { error: "waybillId (numeric rs.ge id) is required" };
      }
      return runWriteTool(
        {
          name: "close_waybill",
          describe: (a) => `close waybill ${a.waybillId}`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/waybills/${a.waybillId}/close`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { waybillId },
        ctx,
      );
    },
  },
  {
    name: "delete_waybill",
    description:
      "Delete a waybill on rs.ge by its numeric rs.ge waybill id. Deleting an UNSENT draft is low-risk and auto-approved; deleting anything already sent is irreversible and queues for human approval.",
    parameters: {
      type: "object",
      properties: { waybillId: { type: "integer", description: "numeric rs.ge waybill id" } },
      required: ["waybillId"],
    },
    async handler(ctx, args) {
      const waybillId = num(args.waybillId);
      if (typeof waybillId !== "number") {
        return { error: "waybillId (numeric rs.ge id) is required" };
      }
      return runWriteTool(
        {
          name: "delete_waybill",
          describe: (a) => `delete waybill ${a.waybillId} on rs.ge`,
          reversible: () => false,
          async autoApprove(a, c) {
            // Auto-approve only when the local mirror shows an UNSENT draft.
            const res = await safeRsGet<{
              waybill: { sent_at?: string | null } | null;
            }>(`/internal/tools/waybills/${a.waybillId}`, c);
            if (res && typeof res === "object" && "waybill" in res) {
              const wb = (res as { waybill: { sent_at?: string | null } | null })
                .waybill;
              return Boolean(wb) && !wb?.sent_at;
            }
            return false;
          },
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/waybills/${a.waybillId}/delete`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { waybillId },
        ctx,
      );
    },
  },
  {
    name: "search_invoices",
    description:
      "List the company's invoices (ანგარიშ-ფაქტურა) from declario's local mirror, newest first — fast, but only as fresh as the last sync. isSale=true for invoices the company issued (output VAT), false for received ones (input VAT). For the live rs.ge view use list_live_invoices.",
    parameters: {
      type: "object",
      properties: {
        isSale: { type: "boolean", description: "true=issued/sales, false=received/purchases" },
        orderId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/invoices`, ctx, {
        isSale:
          typeof args.isSale === "boolean" ? String(args.isSale) : undefined,
        orderId: str(args.orderId),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "list_live_invoices",
    description:
      "Query rs.ge DIRECTLY for the company's invoices — side='seller' for issued, side='buyer' for received. Reflects rs.ge right now (statuses, invoices waiting for the company's reaction), unlike the local mirror. Dates are YYYY-MM-DD; op_from/op_to filter by operation date, reg_from/reg_to by registration date.",
    parameters: {
      type: "object",
      properties: {
        side: { type: "string", enum: ["seller", "buyer"] },
        op_from: { type: "string" },
        op_to: { type: "string" },
        reg_from: { type: "string" },
        reg_to: { type: "string" },
        tin: { type: "string", description: "counterparty TIN filter" },
        invoice_no: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["side"],
    },
    async handler(ctx, args) {
      const side = str(args.side);
      if (side !== "seller" && side !== "buyer") {
        return { error: "side must be 'seller' or 'buyer'" };
      }
      return safeRsGet(`/internal/tools/invoices/live`, ctx, {
        side,
        op_from: str(args.op_from),
        op_to: str(args.op_to),
        reg_from: str(args.reg_from),
        reg_to: str(args.reg_to),
        tin: str(args.tin),
        invoice_no: str(args.invoice_no),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "get_invoice",
    description:
      "Look up one invoice. Pass the numeric rs.ge invoice id to fetch the LIVE invoice with its line items from rs.ge; pass the internal UUID to fetch the local mirror row.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: { type: "string", description: "numeric rs.ge id or internal UUID" },
      },
      required: ["invoiceId"],
    },
    async handler(ctx, args) {
      const id = str(args.invoiceId);
      if (!id) return { error: "invoiceId is required" };
      const numeric = Number(id);
      if (Number.isFinite(numeric) && numeric > 0) {
        return safeRsGet(
          `/internal/tools/invoices/${encodeURIComponent(id)}/details`,
          ctx,
        );
      }
      return safeRsGet(`/internal/tools/invoices/${encodeURIComponent(id)}`, ctx);
    },
  },
  {
    name: "sync_invoices",
    description:
      "Pull the company's seller AND buyer invoices for a period from rs.ge into declario's mirror. Idempotent refresh — run it before drafting/auditing VAT if the user doubts the figures, or when the mirror looks stale. This is what makes input VAT (purchases) real.",
    parameters: {
      type: "object",
      properties: {
        year: { type: "integer", description: "period year; defaults to current" },
        month: { type: "integer", minimum: 1, maximum: 12, description: "period month 1-12; defaults to current" },
      },
    },
    async handler(ctx, args) {
      return safeRsPost(`/internal/tools/invoices/sync`, ctx, {
        year: num(args.year),
        month: num(args.month),
      });
    },
  },
  {
    name: "preview_invoices_from_orders",
    description:
      "Preview the tax invoices (ანგარიშ-ფაქტურა) that can be created from the company's orders for a date WITHOUT touching rs.ge. Returns each invoiceable order (buyer, totals incl. VAT split, the waybill it will reference, warnings), which orders are already invoiced, and totals.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD; orders are matched by their created date (UTC day)",
        },
        orderIds: {
          type: "array",
          items: { type: "string" },
          description: "optional explicit order ids instead of a whole day",
        },
      },
    },
    async handler(ctx, args) {
      const date = str(args.date);
      const orderIds = Array.isArray(args.orderIds)
        ? (args.orderIds as unknown[])
            .map((x) => str(x))
            .filter((x): x is string => Boolean(x))
        : undefined;
      if (!date && (!orderIds || orderIds.length === 0)) {
        return { error: "Provide a date (YYYY-MM-DD) or orderIds" };
      }
      return safeRsGet(`/internal/tools/invoices/preview-from-orders`, ctx, {
        date,
        orderIds: orderIds?.join(","),
      });
    },
  },
  {
    name: "upload_invoices_for_date",
    description:
      "Issue/register tax invoices (ანგარიშ-ფაქტურა) on rs.ge from the company's orders for a date ('ამიწერე/ატვირთე ფაქტურები [date]-ის შეკვეთებზე'). This creates the rs.ge invoices with line items and the linked waybill reference; it does NOT perform any separate buyer-present/send lifecycle action. STRICT TWO-STEP SAFETY: (1) call WITHOUT confirm — it returns the per-order preview (buyer, totals, VAT, linked waybill, warnings), skipped orders, and confirmation_order_ids; show it and ask the user to approve. (2) Call again with confirm=true ONLY after the user explicitly approves in this conversation, passing orderIds from confirmation_order_ids so the issued set exactly matches the preview. Issuing a tax invoice is legally binding. Never set confirm=true on your own. Safe to re-run: already-invoiced orders are skipped.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "YYYY-MM-DD; orders are matched by their created date (UTC day)",
        },
        orderIds: {
          type: "array",
          items: { type: "string" },
          description:
            "optional explicit order ids instead of a whole day; REQUIRED with confirm=true, copied from the preview's confirmation_order_ids",
        },
        confirm: {
          type: "boolean",
          description:
            "true ONLY after the user explicitly approves issuing the previewed invoices. Omit/false to preview only.",
        },
      },
    },
    async handler(ctx, args) {
      const date = str(args.date);
      const orderIds = Array.isArray(args.orderIds)
        ? (args.orderIds as unknown[])
            .map((x) => str(x))
            .filter((x): x is string => Boolean(x))
        : undefined;
      if (!date && (!orderIds || orderIds.length === 0)) {
        return { error: "Provide a date (YYYY-MM-DD) or orderIds" };
      }
      if (args.confirm === true) {
        if (!orderIds || orderIds.length === 0) {
          return {
            error:
              "confirm=true requires orderIds copied from the preview's confirmation_order_ids; do not confirm invoice issuance by date alone.",
          };
        }
        return safeRsPost(`/internal/tools/invoices/upload-from-orders`, ctx, {
          date,
          orderIds,
        });
      }
      const prepared = await safeRsGet(
        `/internal/tools/invoices/preview-from-orders`,
        ctx,
        { date, orderIds: orderIds?.join(",") },
      );
      return {
        requiresConfirmation: true,
        prepared,
        note: "Invoices prepared but NOT created on rs.ge. Show buyers, totals (gross/taxable/VAT), linked waybills and warnings; note which orders are skipped (already invoiced). If the user explicitly approves, call upload_invoices_for_date again with confirm=true and pass orderIds from prepared.confirmation_order_ids; never confirm by date alone.",
      };
    },
  },
  {
    name: "accept_invoice",
    description:
      "Accept/confirm a RECEIVED invoice on rs.ge by its numeric id (purchase invoices count toward input VAT only once accepted). Requires the numeric rs.ge status code to set — read the invoice first (get_invoice / list_live_invoices) if unsure. IRREVERSIBLE — always queues for human approval.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: { type: "integer", description: "numeric rs.ge invoice id" },
        status: { type: "integer", description: "rs.ge status code to confirm with" },
      },
      required: ["invoiceId", "status"],
    },
    async handler(ctx, args) {
      const invoiceId = int(args.invoiceId);
      const status = int(args.status);
      if (typeof invoiceId !== "number" || typeof status !== "number") {
        return { error: "invoiceId and status (integer) are required" };
      }
      return runWriteTool(
        {
          name: "accept_invoice",
          describe: (a) => `accept invoice ${a.invoiceId} (status ${a.status})`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/invoices/${a.invoiceId}/accept`,
              { companyId: c.companyId, userId: c.userId, body: { status: a.status } },
            );
          },
        },
        { invoiceId, status },
        ctx,
      );
    },
  },
  {
    name: "reject_invoice",
    description:
      "Reject a RECEIVED invoice on rs.ge by its numeric id, with a reason the counterparty will see. IRREVERSIBLE — always queues for human approval.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: { type: "integer", description: "numeric rs.ge invoice id" },
        reason: { type: "string", description: "rejection reason shown to the counterparty" },
      },
      required: ["invoiceId", "reason"],
    },
    async handler(ctx, args) {
      const invoiceId = int(args.invoiceId);
      const reason = str(args.reason);
      if (typeof invoiceId !== "number" || !reason) {
        return { error: "invoiceId and reason are required" };
      }
      return runWriteTool(
        {
          name: "reject_invoice",
          describe: (a) => `reject invoice ${a.invoiceId} (${a.reason})`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/invoices/${a.invoiceId}/reject`,
              { companyId: c.companyId, userId: c.userId, body: { reason: a.reason } },
            );
          },
        },
        { invoiceId, reason },
        ctx,
      );
    },
  },
  {
    name: "correct_invoice",
    description:
      "Create a CORRECTION invoice (კორექტირება) for an issued invoice on rs.ge. correctionType: 1=cancel the operation, 2=change operation type, 3=price/compensation change, 4=goods return. IRREVERSIBLE and tax-sensitive — always queues for human approval.",
    parameters: {
      type: "object",
      properties: {
        invoiceId: { type: "integer", description: "numeric rs.ge invoice id of the ORIGINAL invoice" },
        correctionType: { type: "integer", minimum: 1, maximum: 4 },
      },
      required: ["invoiceId", "correctionType"],
    },
    async handler(ctx, args) {
      const invoiceId = int(args.invoiceId);
      const correctionType = int(args.correctionType);
      if (
        typeof invoiceId !== "number" ||
        typeof correctionType !== "number" ||
        correctionType < 1 ||
        correctionType > 4
      ) {
        return { error: "invoiceId and correctionType (integer 1-4) are required" };
      }
      return runWriteTool(
        {
          name: "correct_invoice",
          describe: (a) =>
            `create correction invoice (type ${a.correctionType}) for invoice ${a.invoiceId}`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/invoices/${a.invoiceId}/correct`,
              {
                companyId: c.companyId,
                userId: c.userId,
                body: { k_type: a.correctionType },
              },
            );
          },
        },
        { invoiceId, correctionType },
        ctx,
      );
    },
  },
  {
    name: "list_pipeline_runs",
    description:
      "List the company's recent pipeline runs (the workflows that turn orders into waybills/declarations). Filter by status='failed' to see what broke.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["running", "completed", "failed"] },
        pipelineId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/pipeline-runs`, ctx, {
        status: str(args.status),
        pipelineId: str(args.pipelineId),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "get_pipeline_run",
    description: "Look up a single pipeline run with its step-by-step results and per-step errors.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    async handler(ctx, args) {
      const id = str(args.runId);
      if (!id) return { error: "runId is required" };
      return safeRsGet(
        `/internal/tools/pipeline-runs/${encodeURIComponent(id)}`,
        ctx,
      );
    },
  },
  {
    name: "list_orders",
    description: "List the company's recent orders ingested from connected platforms.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string" },
        source: { type: "string", description: "e.g. 'shopify', 'woocommerce'" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      return safeRsGet(`/internal/tools/orders`, ctx, {
        status: str(args.status),
        source: str(args.source),
        limit: num(args.limit),
      });
    },
  },
  {
    name: "list_integrations",
    description: "List the company's connected platform integrations (Shopify, WooCommerce, etc.). Credentials are stripped.",
    parameters: { type: "object", properties: {} },
    async handler(ctx) {
      return safeRsGet(`/internal/tools/integrations`, ctx);
    },
  },

  // agent-backend reads ──
  {
    name: "get_bulk_run",
    description:
      "Look up a single agent bulk run with all its rows — most useful for explaining why N rows failed in a batch.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    async handler(ctx, args) {
      const id = str(args.runId);
      if (!id) return { error: "runId is required" };
      const run = await findBulkRun(ctx.companyId, id);
      return { run };
    },
  },
  {
    name: "list_failed_bulk_rows",
    description:
      "List failed rows across recent bulk runs for this company, newest first. Each row carries its error text plus the playbook it was running.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string", description: "limit to a specific run (optional)" },
        sinceHours: { type: "integer", minimum: 1, maximum: 720 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    async handler(ctx, args) {
      const sinceHours = num(args.sinceHours) ?? 168; // 7 days default
      const limit = Math.min(num(args.limit) ?? 100, 500);
      const runId = str(args.runId);
      const params: unknown[] = [ctx.companyId, sinceHours, limit];
      const result = await query<{
        run_id: string;
        row_index: number;
        playbook_id: string | null;
        status: string;
        error: string | null;
        attempt_count: number;
        finished_at: string | null;
      }>(
        `
          SELECT r.run_id, r.row_index, r.playbook_id, r.status, r.error,
                 r.attempt_count, r.finished_at
            FROM bulk_run_rows r
            JOIN bulk_runs br ON br.id = r.run_id
           WHERE br.company_id = $1
             AND r.status = 'failed'
             AND r.finished_at >= now() - ($2 || ' hours')::interval
             ${runId ? "AND r.run_id = $4" : ""}
           ORDER BY r.finished_at DESC
           LIMIT $3
        `,
        runId ? [...params, runId] : params,
      );
      return { rows: result.rows };
    },
  },
  {
    name: "get_failure_patterns",
    description:
      "List learned browser-agent failure patterns (e.g. 'this dropdown loses focus at step 3'), optionally narrowed to a domain.",
    parameters: {
      type: "object",
      properties: {
        domain: { type: "string", description: "e.g. 'rs.ge'; omit for all" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
    },
    async handler(ctx, args) {
      const domain = str(args.domain);
      const limit = Math.min(num(args.limit) ?? 30, 100);
      if (domain) {
        return { patterns: await listFailurePatterns(ctx.companyId, domain, limit) };
      }
      const result = await query(
        `SELECT id, domain, url_pattern, field_label, failure_type, symptom,
                workaround, occurrence_count, first_seen_at, last_seen_at
           FROM agent_failure_patterns
          WHERE company_id = $1
          ORDER BY occurrence_count DESC, last_seen_at DESC
          LIMIT $2`,
        [ctx.companyId, limit],
      );
      return { patterns: result.rows };
    },
  },
  {
    name: "list_playbooks",
    description: "List the company's browser-agent playbooks with their review status and step count.",
    parameters: { type: "object", properties: {} },
    async handler(ctx) {
      const rows = await listPlaybooks(ctx.companyId);
      return {
        playbooks: rows.map((r) => ({
          id: r.id,
          name: r.name,
          key: r.key,
          kind: r.kind,
          status: r.status,
          review_status: r.review_status,
          step_count: r.step_count,
          country_code: r.country_code,
        })),
      };
    },
  },
  {
    name: "get_playbook",
    description: "Look up a single playbook with all its steps.",
    parameters: {
      type: "object",
      properties: { playbookId: { type: "string" } },
      required: ["playbookId"],
    },
    async handler(ctx, args) {
      const id = str(args.playbookId);
      if (!id) return { error: "playbookId is required" };
      const playbook = await findPlaybookById(ctx.companyId, id);
      return { playbook };
    },
  },
  {
    name: "list_agent_runs",
    description:
      "List Financial-Agent runs (the AI classifier+tax+plan stack), filterable by status (pending_review, auto_approved, approved, executed, rejected).",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: [
            "pending_review",
            "auto_approved",
            "approved",
            "executed",
            "rejected",
          ],
        },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      const validStatuses: AgentRunStatus[] = [
        "pending_review",
        "auto_approved",
        "approved",
        "executed",
        "rejected",
      ];
      const status = str(args.status);
      const rows = await listAgentRuns({
        companyId: ctx.companyId,
        status:
          status && (validStatuses as string[]).includes(status)
            ? (status as AgentRunStatus)
            : undefined,
        limit: num(args.limit) ?? 50,
      });
      return { runs: rows };
    },
  },
  {
    name: "get_agent_run",
    description: "Look up a single Financial-Agent run with its full classification, tax-reasoning, action plan, and approval decision.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const run = await getAgentRunById(ctx.companyId, id);
      return { run };
    },
  },
  {
    name: "list_schedules",
    description: "List the company's scheduled (cron) playbook runs.",
    parameters: { type: "object", properties: {} },
    async handler(ctx) {
      const rows = await listScheduledRuns(ctx.companyId);
      return { schedules: rows };
    },
  },
  {
    name: "get_schedule",
    description: "Look up a single scheduled run.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const schedule = await findScheduledRunById(ctx.companyId, id);
      return { schedule };
    },
  },
  {
    name: "list_recent_bulk_runs",
    description: "List the company's recent bulk runs, newest first, with summary counts.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    },
    async handler(ctx, args) {
      const rows = await listBulkRuns(ctx.companyId, num(args.limit) ?? 30);
      return { runs: rows };
    },
  },

  // Alerts (Slice B) ──
  {
    name: "list_alerts",
    description:
      "List the company's open alerts (failures the system flagged for attention). Use status='open' for the active queue, 'acknowledged' for in-progress, 'resolved' for closed.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "acknowledged", "resolved", "snoozed"],
        },
        severity: { type: "string", enum: ["info", "warn", "critical"] },
        entityType: { type: "string", description: "e.g. 'bulk_run', 'waybill'" },
        entityId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
    async handler(ctx, args) {
      const status = str(args.status) as AlertStatus | undefined;
      const severity = str(args.severity);
      const validSev = ["info", "warn", "critical"] as const;
      const rows = await listAlerts({
        companyId: ctx.companyId,
        status,
        severity:
          severity && (validSev as readonly string[]).includes(severity)
            ? (severity as (typeof validSev)[number])
            : undefined,
        entityType: str(args.entityType),
        entityId: str(args.entityId),
        limit: num(args.limit) ?? 50,
      });
      return { alerts: rows };
    },
  },
  {
    name: "get_alert",
    description: "Look up a single alert with its full metadata and suggested actions.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const alert = await getAlertById(ctx.companyId, id);
      return { alert };
    },
  },
  {
    name: "acknowledge_alert",
    description:
      "Mark an alert as acknowledged (someone is working on it). Use after the user says they'll handle it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      if (!id) return { error: "id is required" };
      const alert = await setAlertStatus({
        companyId: ctx.companyId,
        id,
        status: "acknowledged",
        reviewedBy: ctx.userId,
      });
      if (!alert) return { error: "Alert not found" };
      return { alert };
    },
  },
  // ── Write tools (Slice C — gated through Approval Gate) ──
  //
  // Each handler delegates to runWriteTool, which evaluates the
  // Approval Gate and either runs the mutation immediately (when safe)
  // or persists it as a pending_review row in agent_runs (when not).
  // The chat brain verbalises the outcome; the alerts UI also uses
  // the same dispatch endpoint and renders {status, agentRunId}.
  {
    name: "retry_bulk_row",
    description:
      "Re-queue a single failed bulk-run row for retry. Auto-approved when the row's last error matches a transient pattern (timeout, ECONNRESET, rate limit, 5xx). Otherwise queues for human approval.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
        rowIndex: { type: "integer", minimum: 0 },
      },
      required: ["runId", "rowIndex"],
    },
    async handler(ctx, args) {
      const runId = str(args.runId);
      const rowIndex = num(args.rowIndex);
      if (!runId || typeof rowIndex !== "number") {
        return { error: "runId and rowIndex are required" };
      }
      const outcome = await runWriteTool(
        {
          name: "retry_bulk_row",
          describe: (a) => `retry bulk row ${a.runId}:${a.rowIndex}`,
          reversible: () => true, // requeue is idempotent
          async autoApprove(a, c) {
            // Auto-approve when the existing row.error matches a
            // transient regex bucket. Reads the row directly so we
            // never auto-fire on stale assumptions.
            const r = await query<{ error: string | null }>(
              `SELECT r.error
                 FROM bulk_run_rows r
                 JOIN bulk_runs br ON br.id = r.run_id
                WHERE br.company_id = $1 AND r.run_id = $2 AND r.row_index = $3
                LIMIT 1`,
              [c.companyId, a.runId, a.rowIndex],
            );
            const errText = r.rows[0]?.error ?? "";
            const cls = classifyErrorText(errText);
            return cls === "network" || cls === "timeout" || cls === "rate_limit" || cls === "portal_error";
          },
          async execute(a, c) {
            // Tenant guard: confirm the row belongs to the company.
            const owned = await findBulkRun(c.companyId, a.runId);
            if (!owned) throw new Error(`Run ${a.runId} not found`);
            const attempt = await requeueRowForRetry(a.runId, a.rowIndex);
            if (attempt === null) {
              throw new Error(`Row ${a.runId}:${a.rowIndex} not retryable`);
            }
            return { runId: a.runId, rowIndex: a.rowIndex, attemptCount: attempt };
          },
        },
        { runId, rowIndex },
        ctx,
      );
      return outcome;
    },
  },
  {
    name: "retry_bulk_failed",
    description:
      "Re-queue ALL failed rows in a bulk run. Large blast radius — always queues for human approval.",
    parameters: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    async handler(ctx, args) {
      const runId = str(args.runId);
      if (!runId) return { error: "runId is required" };
      return runWriteTool(
        {
          name: "retry_bulk_failed",
          describe: (a) => `retry all failed rows in bulk run ${a.runId}`,
          reversible: () => false, // many rows; effect compounds
          async execute(a, c) {
            const owned = await findBulkRun(c.companyId, a.runId);
            if (!owned) throw new Error(`Run ${a.runId} not found`);
            const reset = await resetIncompleteRows(a.runId);
            return { runId: a.runId, rowsReset: reset };
          },
        },
        { runId },
        ctx,
      );
    },
  },
  {
    name: "retry_operation_item",
    description:
      "Re-trigger a single operations item (e.g. a single waybill shipment) through the rs-server pipeline. Idempotent — auto-approved.",
    parameters: {
      type: "object",
      properties: { itemId: { type: "string" } },
      required: ["itemId"],
    },
    async handler(ctx, args) {
      const itemId = str(args.itemId);
      if (!itemId) return { error: "itemId is required" };
      return runWriteTool(
        {
          name: "retry_operation_item",
          describe: (a) => `retry operation item ${a.itemId}`,
          reversible: () => true,
          async autoApprove() {
            return true; // existing endpoint is idempotent
          },
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/operations/items/${encodeURIComponent(a.itemId)}/retry`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { itemId },
        ctx,
      );
    },
  },
  {
    name: "trigger_pipeline",
    description:
      "Manually trigger a pipeline run on rs-server. Queues for approval because it can kick rs.ge submissions.",
    parameters: {
      type: "object",
      properties: { pipelineId: { type: "string" } },
      required: ["pipelineId"],
    },
    async handler(ctx, args) {
      const pipelineId = str(args.pipelineId);
      if (!pipelineId) return { error: "pipelineId is required" };
      return runWriteTool(
        {
          name: "trigger_pipeline",
          describe: (a) => `trigger pipeline ${a.pipelineId}`,
          reversible: () => false,
          async execute(a, c) {
            return rsServerClient.post(
              `/internal/tools/pipelines/${encodeURIComponent(a.pipelineId)}/trigger`,
              { companyId: c.companyId, userId: c.userId, body: {} },
            );
          },
        },
        { pipelineId },
        ctx,
      );
    },
  },
  {
    name: "skip_bulk_row",
    description:
      "Mark a single failed bulk-run row as skipped with a reason. Data-loss-ish — always queues for approval.",
    parameters: {
      type: "object",
      properties: {
        runId: { type: "string" },
        rowIndex: { type: "integer", minimum: 0 },
        reason: { type: "string", description: "why the row is being skipped" },
      },
      required: ["runId", "rowIndex", "reason"],
    },
    async handler(ctx, args) {
      const runId = str(args.runId);
      const rowIndex = num(args.rowIndex);
      const reason = str(args.reason);
      if (!runId || typeof rowIndex !== "number" || !reason) {
        return { error: "runId, rowIndex, and reason are required" };
      }
      return runWriteTool(
        {
          name: "skip_bulk_row",
          describe: (a) => `skip bulk row ${a.runId}:${a.rowIndex} (${a.reason})`,
          reversible: () => false,
          async execute(a, c) {
            const owned = await findBulkRun(c.companyId, a.runId);
            if (!owned) throw new Error(`Run ${a.runId} not found`);
            const updated = await skipBulkRow(a.runId, a.rowIndex, a.reason);
            if (!updated) {
              throw new Error(
                `Row ${a.runId}:${a.rowIndex} not skippable (must be pending or failed)`,
              );
            }
            return { runId: a.runId, rowIndex: a.rowIndex, status: updated.status };
          },
        },
        { runId, rowIndex, reason },
        ctx,
      );
    },
  },
  // amend_declaration is intentionally NOT executed automatically —
  // editing tax filings is the highest-risk fix in the catalog, and
  // the actual amend path on rs-server doesn't exist yet. Today this
  // tool ALWAYS queues for human review, surfacing the intent in
  // /dashboard/ai/approvals where an accountant can amend by hand.
  {
    name: "amend_declaration",
    description:
      "Request an amendment to a declaration (e.g. fix a TIN, correct an amount). Always queues for human review — declario does not auto-edit tax filings.",
    parameters: {
      type: "object",
      properties: {
        declarationId: { type: "string" },
        patch: { type: "object", description: "fields to amend" },
      },
      required: ["declarationId", "patch"],
    },
    async handler(ctx, args) {
      const declarationId = str(args.declarationId);
      const patch =
        args.patch && typeof args.patch === "object" && !Array.isArray(args.patch)
          ? (args.patch as Record<string, unknown>)
          : null;
      if (!declarationId || !patch) {
        return { error: "declarationId and patch are required" };
      }
      return runWriteTool(
        {
          name: "amend_declaration",
          describe: (a) =>
            `amend declaration ${a.declarationId}: ${Object.keys(
              (a.patch as Record<string, unknown>) ?? {},
            ).join(", ")}`,
          reversible: () => false,
          async execute() {
            // Always queues; this branch only fires if the gate
            // policy ever flips. Keep it explicit so a future
            // operator never auto-amends by accident.
            throw new Error(
              "amend_declaration must always go through human approval — auto-execute is disabled by design.",
            );
          },
        },
        { declarationId, patch },
        ctx,
      );
    },
  },

  {
    name: "snooze_alert",
    description:
      "Snooze an alert for N hours. Useful when the user wants to deal with it later — it'll reappear after the snooze expires unless the underlying issue resolved itself.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        hours: { type: "number", minimum: 1, maximum: 720 },
      },
      required: ["id", "hours"],
    },
    async handler(ctx, args) {
      const id = str(args.id);
      const hours = num(args.hours);
      if (!id) return { error: "id is required" };
      if (!hours || hours <= 0) return { error: "hours must be a positive number" };
      const until = new Date(Date.now() + hours * 3600_000).toISOString();
      const alert = await setAlertStatus({
        companyId: ctx.companyId,
        id,
        status: "snoozed",
        snoozedUntil: until,
        reviewedBy: ctx.userId,
      });
      if (!alert) return { error: "Alert not found" };
      return { alert };
    },
  },
];

// ── Public API ──────────────────────────────────────────────────────────

const toolByName = new Map(CHAT_TOOLS.map((t) => [t.name, t]));

/**
 * Function declarations as accepted by `geminiService.generateWithTools`.
 * Keep this in sync with `CHAT_TOOLS` automatically.
 */
export function toolDeclarations(): FunctionDeclaration[] {
  return CHAT_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters as never,
  }));
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCallContext,
): Promise<unknown> {
  const tool = toolByName.get(name);
  if (!tool) {
    return { error: `Unknown tool: ${name}` };
  }
  try {
    return await tool.handler(ctx, args);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The system instruction shown to the model when chat tools are enabled.
 * Names the available tools and the rules for when to call them.
 */
export function chatToolSystemInstruction(): string {
  const lines = CHAT_TOOLS.map(
    (t) => `- ${t.name}: ${t.description}`,
  ).join("\n");
  return [
    "Scope policy: only help with finance, accounting, bookkeeping, taxes, payroll, VAT, profit tax, invoices, waybills, bank statements, declarations, rs.ge, business operations data, uploaded financial documents/spreadsheets, and Declario product workflows. If the user asks about politics, public figures, entertainment, gossip, culture-war/provocative topics, general trivia, medical, coding, or any other off-topic subject, do not answer the substance. Briefly say you can help with finance/accounting/tax/rs.ge topics and ask them to reframe it in that context.",
    "You are declario's chat assistant for accountants and SMB owners.",
    "When the user asks about live data — a specific waybill, declaration, pipeline run, bulk run, order, schedule, playbook, or AI run, or about why something failed — CALL ONE OF THE TOOLS BELOW first. Do not fabricate IDs, statuses, or error reasons. If you need data, ask the tool; if the tool returns nothing or an error, say so plainly.",
    "Computing or verifying THE COMPANY'S OWN figures for a period is LIVE DATA, not a general question — call the matching tool and base every number strictly on its result, reading out any warnings or discrepancies: `draft_vat_return` for VAT (დღგ); `draft_payroll` for payroll/salaries (ხელფასები — gross / income tax 20% / pension); `audit_vat_submission` to CHECK/VERIFY an already-prepared or submitted VAT declaration against current data ('გადაამოწმე ჩემი ატვირთული დღგ', 'is my submitted VAT correct'). Do NOT call these for GENERAL questions — the rate, definitions, how a rule works, or how to fill a form — answer those from the knowledge base, citing the relevant articles. For profit tax (მოგების გადასახადი) use `draft_profit_tax`, extracting the distribution events (dividends, non-business expenses, free supplies, representation over limit) and their net amounts from the user's message. There is no computation tool yet for the small-business 1% tax — for it, compute 1% of the turnover the user states, citing the knowledge base.",
    "Disambiguate Georgian salary requests carefully. If the user provides a pasted/parsed employee list and asks to add/import salaries, call `import_employees`, then `draft_payroll`. If the employee records already exist and the user asks to upload/file/send payroll for a period ('ხელფასები ამიტვირთე/გააგზავნე/დააფიქსირე'), use `file_payroll`.",
    "To FILE payroll on rs.ge use `file_payroll` with the same strict two-step protocol: first prepare without confirm and show the exact period, employee count, gross, income tax, pension, net, warnings and approval expiry; only call again with confirm=true after explicit approval of that preview, passing the exact payroll_run_id, approval_id and snapshot_hash returned by preparation. The server rejects stale, expired, reused or cross-user approvals. Never claim it is submitted merely because the playbook was dispatched; report the returned runtime status and receipt.",
    "To FILE/submit a VAT declaration on rs.ge ('დააფიქსირე/გააგზავნე ჩემი დღგ') use `file_vat_return` with a STRICT two-step protocol: first call it WITHOUT confirm to prepare and show the figures, then ask the user to explicitly approve filing THIS declaration; only call it again with confirm=true AFTER the user clearly says yes in this conversation, passing the returned declaration_id, approval.id and approval.snapshot_hash. NEVER set confirm=true on your own initiative, and never claim a declaration is 'filed/submitted' until the tool result confirms it. (Filing runs the rs.ge playbook in halt-on-dangerous mode: it fills the form and stops before the final submit for the user to finalize.) For PAYROLL there is no chat filing tool — payroll filing needs a real user's approval in the dashboard. The chat can draft_payroll (compute) and import_employees, but tell the user to file the payroll declaration from the Payroll page.",
    "To CREATE AND SEND waybills (ზედნადები) to rs.ge from the company's orders ('ატვირთე/გააგზავნე ზედნადები [date]-ის შეკვეთებზე') use `upload_waybills_for_date` with the SAME strict two-step protocol: first call it WITHOUT confirm to build the preview, then show the per-order buyers, goods, amounts, totals and warnings, note which orders are skipped (already sent) and which existing drafts will be sent, and ask the user to explicitly approve sending. Only call it again with confirm=true AFTER the user clearly says yes, passing orderIds copied from the preview's confirmation_order_ids so new orders cannot sneak in after preview. NEVER set confirm=true on your own or confirm by date alone. Sending is irreversible on rs.ge; never claim a waybill is sent until the tool result confirms it. Use `preview_waybills_from_orders` for a no-send dry run. For one-off lifecycle actions on an existing waybill (by its numeric rs.ge id) use `send_waybill`/`confirm_waybill`/`close_waybill`/`reject_waybill`/`delete_waybill` — these are irreversible and gate through human approval (except deleting an unsent draft, which is auto-approved).",
    "To ISSUE/register tax invoices (ანგარიშ-ფაქტურა) on rs.ge from the company's orders ('ამიწერე/ატვირთე ფაქტურები [date]-ის შეკვეთებზე') use `upload_invoices_for_date` with the same strict two-step protocol: preview WITHOUT confirm (buyers, gross/taxable/VAT, linked waybills, warnings, skipped already-invoiced orders, confirmation_order_ids) → explicit user approval → confirm=true with orderIds copied from confirmation_order_ids. Issuing an invoice is legally binding; never claim one is issued until the tool result confirms it, and never confirm by date alone because new orders may appear after the preview. This creates/registers the invoice on rs.ge; it does not perform a separate buyer-present/send step. `preview_invoices_from_orders` is the no-write dry run. To READ invoices: `search_invoices` (local mirror, fast) vs `list_live_invoices` (queries rs.ge directly — use for current statuses or 'invoices waiting for my reaction'); `get_invoice` fetches one with line items. `sync_invoices` refreshes the mirror for a period — run it before VAT work if figures look stale. For reacting to a RECEIVED invoice use `accept_invoice` (needs the rs.ge status code — read the invoice first) or `reject_invoice` (with a reason); for fixing an ISSUED one use `correct_invoice` (1=cancel, 2=change operation type, 3=price change, 4=goods return). These three are irreversible and always queue for human approval.",
    "When the user asks a general accounting/tax-code question (definitions, how a rule works, what the law says — not their own numbers), answer from your training and the RAG context (no tool call needed), citing the relevant articles.",
    "After tool results come back, write a concise human answer. Quote specific IDs and short error excerpts so the user can navigate to the right page.",
    "Available tools:",
    lines,
  ].join("\n\n");
}

/**
 * Cheap regex that says "this message is about live data and we should
 * skip the expensive RAG embed on the first turn." Tool-calling will
 * still happen either way; this just avoids burning an embedding call.
 */
export function looksLikeDiagnosticQuery(text: string): boolean {
  // Live-data lookups (waybills/declarations/…) AND company-own computations
  // (e.g. "compute our VAT for May") skip the RAG embed and go straight to the
  // tool loop: their answer lives in live data + tools, not the book corpus,
  // and a noisy RAG context otherwise distracts the model from calling the
  // tool. General tax questions ("what is the VAT rate") still go through RAG.
  if (
    /\b(waybill|declaration|pipeline|bulk|failed|retry|alert|error|status|order|playbook|schedule|run|upload)\b|ზედნადებ|#\d+/i.test(
      text,
    )
  ) {
    return true;
  }
  const taxTopic =
    /(დღგ|\bvat\b|ხელფას|payroll|ანაზღაურ|დეკლარაცი|declaration|ზედნადებ|waybill|ფაქტურ|invoice|მოგების გადასახად|profit tax|დივიდენდ|dividend)/i.test(
      text,
    );
  const actionIntent =
    /(გამოთვალ|დამიდგ|რამდენ|გადასახდ|ჩვენ|ჩემ|მაჩვენ|მიძებნ|იპოვ|სია|სტატუს|ამიწერ|გამიწერ|draft|compute|prepare|owe|how much|list|show|find|search|sync|issue|create|accept|reject|correct|confirm|გადაამოწმ|შეამოწმ|audit|verify|სწორია|დააფიქს|გააგზავ|file|submit|ტვირთ|ატვირთ|upload|send|დაამატ|import)/i.test(
      text,
    );
  return taxTopic && actionIntent;
}
