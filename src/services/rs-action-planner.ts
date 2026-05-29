import { GeminiService } from "./gemini";
import {
  expectBoolean,
  expectEnum,
  expectNumber,
  expectObject,
  expectString,
  expectStringArray,
  runStructuredAgent,
  type StructuredAgentInput,
  type StructuredAgentResult,
  type StructuredAgentSpec,
} from "./structured-agent";
import type { ClassifierOutput } from "./classifier";
import type { TaxReasoningOutput } from "./tax-reasoning";

/**
 * Agent #3 — RS Action Planner.
 *
 * Input: the outputs of #1 (Classifier) + #2 (Tax Reasoning) plus optional
 * context about what's already pending on rs.ge for the same period.
 * Output: an ordered list of concrete actions to take on the tax-authority
 * portal — each action keyed to a recorded playbook in the agent-backend
 * playbook library.
 *
 * The planner does NOT execute anything — it just emits the plan. The
 * Approval Gate runs against this plan, and then (if approved) the
 * existing bulk-run + playbook executor in agent-backend dispatches each
 * action against rs.ge / am.src / kz.is-esf / az.eqaime.
 *
 * Why this is its own agent rather than a continuation of #2: the tax
 * judgment ("this is taxable, increases output VAT") is country-agnostic;
 * the action plan ("submit invoice ID X via rs.ge save_invoice + activate
 * via send_waybill") is country-specific and changes per portal. Keeping
 * them separate means the same Tax Reasoning brain can drive any
 * jurisdiction once we wire its TaxAuthorityAdapter.
 */

// ── Output type ────────────────────────────────────────────────────────────

export type ActionType =
  | "submit_vat_invoice"
  | "submit_waybill"
  | "activate_waybill"
  | "update_purchase_ledger"
  | "update_sales_ledger"
  | "amend_previous_declaration"
  | "request_documentation"
  | "wait_for_period_close"
  | "skip_no_action";

export const ACTION_TYPES: readonly ActionType[] = [
  "submit_vat_invoice",
  "submit_waybill",
  "activate_waybill",
  "update_purchase_ledger",
  "update_sales_ledger",
  "amend_previous_declaration",
  "request_documentation",
  "wait_for_period_close",
  "skip_no_action",
] as const;

export type ActionPriority = "high" | "medium" | "low";
export const ACTION_PRIORITIES: readonly ActionPriority[] = ["high", "medium", "low"] as const;

export type McpServerName = "rs-ge" | "none";
export const MCP_SERVER_NAMES: readonly McpServerName[] = ["rs-ge", "none"] as const;

export interface PlannedAction {
  type: ActionType;
  priority: ActionPriority;
  /** Playbook key the agent-backend executor should replay (e.g. "rs.ge.waybill"). */
  playbook_key: string;
  /** MCP server that can execute this action. Use "none" for ledger/no-op actions. */
  mcp_server: McpServerName;
  /** Exact rs-mcp tool name (e.g. "save_invoice", "send_waybill"), or "none". */
  mcp_tool_name: string;
  /** Draft MCP arguments, using only fields present in the input. */
  mcp_args: Record<string, unknown>;
  /** True for rs-mcp read-only tools. False for queued/destructive tools. */
  mcp_read_only: boolean;
  /** True when rs-mcp will queue a pending action requiring confirm_action. */
  requires_confirmation: boolean;
  /** ISO 3166-1 alpha-2 country whose adapter handles this action. */
  country_code: string;
  /** Short human-readable description shown in the action queue. */
  description: string;
  /** Required input fields the playbook will need (TIN, amounts, etc.). */
  required_inputs: string[];
  /**
   * If true, this action is reversible — submitting can be undone. If false,
   * the Approval Gate should require human approval regardless of confidence.
   */
  reversible: boolean;
}

export interface RsActionPlannerOutput {
  actions: PlannedAction[];
  /** One-line rationale for the overall plan. */
  plan_rationale: string;
  warnings: string[];
  confidence: number;
}

// ── Spec ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the RS Action Planner inside declario. You receive a classified
operation, a tax judgment, and optional context, and you emit an ordered
list of concrete actions to take on the tax-authority portal.

HOW EXECUTION ACTUALLY WORKS in declario:
  - WRITE actions (creating/sending/activating an invoice, waybill, or
    declaration) are NEVER executed via MCP. They run through the
    browser-automation playbook layer (\`playbook_key\` + the
    agent-runtime). The MCP server today is READ-ONLY.
  - The MCP fields on a write action exist only to declare INTENT
    (which portal flow, which arguments) so the audit log knows what
    the planner asked for. For write actions, set mcp_server="none",
    mcp_tool_name="none", mcp_args={}, mcp_read_only=false.
  - READ actions (verifying a counterparty TIN, checking an existing
    invoice, listing waybills before sending a new one) DO run via
    MCP. Use mcp_server="rs-ge" with one of the rsge_* tools below.
    These are safe, do not mutate the portal, and never need a
    playbook.

ABSOLUTE RULES:
  1. Never emit an action that requires data not present in the input. If
     you need a TIN, invoice ID, unique taxpayer ID, waybill ID,
     declaration sequence number, service-user ID, or any other portal
     argument, declare it in required_inputs instead of inventing one.
  2. Order matters. Actions with priority "high" run first. Within a
     priority, list them in execution order, e.g. verify counterparty
     before sending invoice, save waybill before activating it.
  3. If tax reasoning says "do_not_submit" or "hold_for_documentation",
     emit a single skip_no_action OR request_documentation action; never
     emit a portal write.
  4. playbook_key MUST follow "<country>.<portal>.<flow>", e.g.
     "rs.ge.invoice", "rs.ge.waybill", "rs.ge.waybill_activate".
     For Armenia/Kazakhstan/Azerbaijan use "am.src.*", "kz.is-esf.*",
     "az.eqaime.*". For pure-MCP read actions, playbook_key="none".
  5. MCP draft per action:
     - WRITE actions (submit_vat_invoice, submit_waybill, activate_waybill,
       update_*_ledger, amend_previous_declaration): set
       mcp_server="none", mcp_tool_name="none", mcp_args={},
       mcp_read_only=false, requires_confirmation=true. The playbook
       layer does the actual write.
     - READ/verify actions (request_documentation when a tin/un_id lookup
       is enough): set mcp_server="rs-ge", pick an rsge_* tool, fill
       mcp_args from the input, mcp_read_only=true,
       requires_confirmation=false.
     - skip_no_action / wait_for_period_close: mcp_server="none",
       mcp_tool_name="none", mcp_args={}, mcp_read_only=false,
       requires_confirmation=false.
  6. reversible is true ONLY for ledger updates and clear draft-only saves.
     Any submit/send/confirm/reject/close/activate flow is NOT reversible
     once the playbook layer runs it.
  7. If no action is needed, emit exactly one skip_no_action with
     priority="low", mcp_server="none", mcp_tool_name="none", mcp_args={},
     mcp_read_only=false, requires_confirmation=false.
  8. Output ONE valid JSON object. No prose. No markdown fences.

PLAYBOOK KEY VOCABULARY (Georgia — first jurisdiction; others scaffold):
  - rs.ge.invoice              save/send B2B invoice via rs.ge
  - rs.ge.waybill              save waybill draft
  - rs.ge.waybill_activate     activate saved waybill
  - rs.ge.vat-return           VAT return portal flow

RS-MCP READ-ONLY TOOLS (use ONLY these for mcp_tool_name when mcp_server="rs-ge"):
  - rsge_list_workspaces                no args; current service contexts
  - rsge_service_context                no args; active workspace info
  - rsge_list_waybills                  args: { date_from, date_to, ... }
  - rsge_list_buyer_waybills            args: { date_from, date_to, ... }
  - rsge_get_waybill                    args: { waybill_id }
  - rsge_list_seller_invoices           args: { date_from, date_to }
  - rsge_list_buyer_invoices            args: { date_from, date_to }
  - rsge_get_invoice                    args: { invoice_id }
  - rsge_get_invoice_desc               args: { invoice_id }
  - rsge_print_invoice                  args: { invoice_id }
  - rsge_reference_catalog              args: { catalog_name }
  - rsge_error_codes                    args: { service_name? }
  - rsge_service_users                  no args
  - rsge_lookup_tin                     args: { un_id }
  - rsge_lookup_un_id                   args: { tin }

Examples:
  - Taxable B2B sale: emit a WRITE action with
    type="submit_vat_invoice", playbook_key="rs.ge.invoice",
    mcp_server="none", mcp_tool_name="none", mcp_args={},
    mcp_read_only=false, requires_confirmation=true, reversible=false.
    The browser playbook handles the actual submit on rs.ge.
  - Need to verify the buyer's name before submitting:
    type="request_documentation", playbook_key="none",
    mcp_server="rs-ge", mcp_tool_name="rsge_lookup_tin",
    mcp_args={un_id}, mcp_read_only=true,
    requires_confirmation=false. (Put un_id in required_inputs if absent.)`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          type: { type: "string", enum: ACTION_TYPES as unknown as string[] },
          priority: {
            type: "string",
            enum: ACTION_PRIORITIES as unknown as string[],
          },
          playbook_key: { type: "string" },
          mcp_server: { type: "string", enum: MCP_SERVER_NAMES as unknown as string[] },
          mcp_tool_name: { type: "string" },
          mcp_args: { type: "object" },
          mcp_read_only: { type: "boolean" },
          requires_confirmation: { type: "boolean" },
          country_code: { type: "string" },
          description: { type: "string" },
          required_inputs: { type: "array", items: { type: "string" } },
          reversible: { type: "boolean" },
        },
        required: [
          "type",
          "priority",
          "playbook_key",
          "mcp_server",
          "mcp_tool_name",
          "mcp_args",
          "mcp_read_only",
          "requires_confirmation",
          "country_code",
          "description",
          "required_inputs",
          "reversible",
        ],
      },
    },
    plan_rationale: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["actions", "plan_rationale", "warnings", "confidence"],
};

export const rsActionPlannerAgent: StructuredAgentSpec<RsActionPlannerOutput> = {
  key: "rs-action-planner-v1",
  systemPrompt: SYSTEM_PROMPT,
  responseSchema: RESPONSE_SCHEMA,
  temperature: 0.1,
  maxOutputTokens: 1024,
  maxRetries: 1,
  validate(raw: unknown): RsActionPlannerOutput {
    const obj = expectObject(raw, "rs_action_planner");
    const actionsRaw = obj.actions;
    if (!Array.isArray(actionsRaw)) {
      throw new Error("rs_action_planner: actions must be an array");
    }
    const actions: PlannedAction[] = actionsRaw.map((a, i) => {
      const r = expectObject(a, `rs_action_planner.actions[${i}]`);
      return {
        type: expectEnum(r.type, ACTION_TYPES, `rs_action_planner.actions[${i}].type`),
        priority: expectEnum(
          r.priority,
          ACTION_PRIORITIES,
          `rs_action_planner.actions[${i}].priority`,
        ),
        playbook_key: expectString(
          r.playbook_key,
          `rs_action_planner.actions[${i}].playbook_key`,
        ),
        mcp_server: expectEnum(
          r.mcp_server,
          MCP_SERVER_NAMES,
          `rs_action_planner.actions[${i}].mcp_server`,
        ),
        mcp_tool_name: expectString(
          r.mcp_tool_name,
          `rs_action_planner.actions[${i}].mcp_tool_name`,
        ),
        mcp_args: expectObject(r.mcp_args, `rs_action_planner.actions[${i}].mcp_args`),
        mcp_read_only: expectBoolean(
          r.mcp_read_only,
          `rs_action_planner.actions[${i}].mcp_read_only`,
        ),
        requires_confirmation: expectBoolean(
          r.requires_confirmation,
          `rs_action_planner.actions[${i}].requires_confirmation`,
        ),
        country_code: expectString(
          r.country_code,
          `rs_action_planner.actions[${i}].country_code`,
        ),
        description: expectString(
          r.description,
          `rs_action_planner.actions[${i}].description`,
        ),
        required_inputs: expectStringArray(
          r.required_inputs,
          `rs_action_planner.actions[${i}].required_inputs`,
        ),
        reversible:
          typeof r.reversible === "boolean"
            ? r.reversible
            : (() => {
                throw new Error(
                  `rs_action_planner.actions[${i}].reversible: expected boolean`,
                );
              })(),
      };
    });
    return {
      actions,
      plan_rationale: expectString(obj.plan_rationale, "rs_action_planner.plan_rationale"),
      warnings: expectStringArray(obj.warnings, "rs_action_planner.warnings"),
      confidence: expectNumber(obj.confidence, "rs_action_planner.confidence"),
    };
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

export interface RsActionPlannerInput {
  operation: Record<string, unknown>;
  classification: ClassifierOutput;
  taxReasoning: TaxReasoningOutput;
  /** Country whose portal we're targeting; the planner will route accordingly. */
  countryCode: string;
  /** Already-pending or already-submitted actions for the same operation. */
  alreadyDone?: Array<{ type: ActionType; submitted_at: string; reference: string }>;
  /** Optional RAG chunks (portal manuals, error codes). */
  ragChunks?: StructuredAgentInput["ragChunks"];
}

export async function planRsActions(
  input: RsActionPlannerInput,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<RsActionPlannerOutput>> {
  return runStructuredAgent(
    rsActionPlannerAgent,
    {
      payload: {
        operation: input.operation,
        classification: input.classification,
        tax_reasoning: input.taxReasoning,
        country_code: input.countryCode,
        already_done: input.alreadyDone ?? [],
      },
      ragChunks: input.ragChunks,
    },
    opts,
  );
}
