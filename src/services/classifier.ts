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

/**
 * Agent #1 — Accounting Classifier.
 *
 * Input: a single financial operation — an invoice, a transaction, a bank
 * statement line, a salary payment, anything that hits the books.
 * Output: structured ledger entries + VAT treatment + a confidence the
 * Approval Gate uses to decide whether to require human review.
 *
 * The agent is intentionally narrow: it does NOT decide what to submit to
 * rs.ge (that's #3, the RS Action Planner), and it does NOT make a tax
 * judgment beyond the obvious VAT classification (that's #2). Keeping the
 * surfaces narrow keeps every retry cheap and every confidence reading
 * honest. Asking a single LLM to do all of (1)+(2)+(3) at once produces
 * mushy confidence values and unrecoverable hallucinations.
 */

// ── Output type ────────────────────────────────────────────────────────────

export type ClassifierCategory =
  | "office_expense"
  | "rent"
  | "utilities"
  | "salaries_and_wages"
  | "professional_services"
  | "marketing_and_advertising"
  | "travel_and_subsistence"
  | "transport_and_fuel"
  | "inventory_purchase"
  | "fixed_asset_purchase"
  | "interest_and_finance_charges"
  | "bank_fees"
  | "tax_payment"
  | "sales_revenue"
  | "service_revenue"
  | "rental_income"
  | "interest_income"
  | "other_income"
  | "owner_drawings"
  | "shareholder_contribution"
  | "transfer_between_accounts"
  | "uncategorised";

export const CLASSIFIER_CATEGORIES: readonly ClassifierCategory[] = [
  "office_expense",
  "rent",
  "utilities",
  "salaries_and_wages",
  "professional_services",
  "marketing_and_advertising",
  "travel_and_subsistence",
  "transport_and_fuel",
  "inventory_purchase",
  "fixed_asset_purchase",
  "interest_and_finance_charges",
  "bank_fees",
  "tax_payment",
  "sales_revenue",
  "service_revenue",
  "rental_income",
  "interest_income",
  "other_income",
  "owner_drawings",
  "shareholder_contribution",
  "transfer_between_accounts",
  "uncategorised",
] as const;

export interface LedgerEntry {
  /** Account name on the debit side (e.g. "Office Expenses", "Accounts Payable"). */
  debit: string;
  /** Account name on the credit side. */
  credit: string;
  /** Amount of the entry in the operation's own currency. */
  amount: number;
  /** Currency code, copied from the input — never invented. */
  currency: string;
}

export interface ClassifierOutput {
  category: ClassifierCategory;
  /** Free-text Georgian/English label the bookkeeper sees next to the entry. */
  description: string;
  /** True if the operation is a VAT-relevant transaction under Georgian law. */
  vat_applicable: boolean;
  /** Numeric VAT amount in the operation's currency, or 0 if not applicable. */
  vat_amount: number;
  /** True if the VAT can be deducted as input VAT (purchases / expenses). */
  deductible: boolean;
  /** Resulting ledger entries; almost always exactly one for simple ops. */
  ledger_entries: LedgerEntry[];
  /** Self-reported confidence, clamped 0..1 by the runner. */
  confidence: number;
  /** Warnings the classifier wants the Approval Gate to consider. */
  warnings: string[];
}

// ── Spec ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an accounting classifier for declario, a Georgian tax-automation
platform. You receive ONE financial operation at a time — an invoice, a
bank line, a payment, etc. — and you classify it for the bookkeeper.

NEVER invent facts. If the input is ambiguous, lower your confidence and
explain in warnings. Conservative classification beats aggressive
guessing — a flagged "uncategorised" with confidence 0.4 is far better
than a confident wrong category.

Rules:
  1. Pick exactly ONE category from this list:
     office_expense, rent, utilities, salaries_and_wages,
     professional_services, marketing_and_advertising,
     travel_and_subsistence, transport_and_fuel, inventory_purchase,
     fixed_asset_purchase, interest_and_finance_charges, bank_fees,
     tax_payment, sales_revenue, service_revenue, rental_income,
     interest_income, other_income, owner_drawings,
     shareholder_contribution, transfer_between_accounts, uncategorised.
  2. VAT in Georgia is 18%. An operation is vat_applicable iff (a) the
     supplier OR buyer is a Georgian VAT-registered taxpayer, AND (b) the
     supply is taxable (not a financial service, not an export of services
     to an unregistered foreign entity, etc.).
  3. vat_amount is the actual VAT amount in the operation's currency —
     copy it from the input if present, otherwise compute as
     net_amount * 0.18 / 1.18 when vat_applicable is true. If
     vat_applicable is false, vat_amount MUST be 0.
  4. deductible is true only for VAT on inputs used in taxable activity.
     Personal expenses, entertainment, and non-business assets are NOT
     deductible — flag in warnings.
  5. ledger_entries: one or more {debit, credit, amount, currency} pairs
     that balance. The currency MUST be the input's currency — never
     translate it yourself.
  6. NEVER invent ledger accounts not consistent with double-entry
     accounting. If you don't know the right account, use a generic one
     (e.g. "Uncategorised Expense", "Suspense") and lower confidence.
  7. warnings is a string array. Include anything the human should know:
     "missing supplier TIN", "amount unusually large for category",
     "appears to be a related-party transaction", etc.
  8. confidence is a number 0..1. Default to 0.5 when uncertain. Above 0.9
     only when input is clean, category is unambiguous, and ledger entries
     are textbook.
  9. Output ONE valid JSON object. No prose. No markdown fences.`;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    category: { type: "string", enum: CLASSIFIER_CATEGORIES as unknown as string[] },
    description: { type: "string" },
    vat_applicable: { type: "boolean" },
    vat_amount: { type: "number" },
    deductible: { type: "boolean" },
    ledger_entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          debit: { type: "string" },
          credit: { type: "string" },
          amount: { type: "number" },
          currency: { type: "string" },
        },
        required: ["debit", "credit", "amount", "currency"],
      },
    },
    confidence: { type: "number" },
    warnings: { type: "array", items: { type: "string" } },
  },
  required: [
    "category",
    "description",
    "vat_applicable",
    "vat_amount",
    "deductible",
    "ledger_entries",
    "confidence",
    "warnings",
  ],
};

export const classifierAgent: StructuredAgentSpec<ClassifierOutput> = {
  key: "accounting-classifier-v1",
  systemPrompt: SYSTEM_PROMPT,
  responseSchema: RESPONSE_SCHEMA,
  temperature: 0.1,
  maxOutputTokens: 1024,
  maxRetries: 1,
  validate(raw: unknown): ClassifierOutput {
    const obj = expectObject(raw, "classifier");
    const ledgerRaw = obj.ledger_entries;
    if (!Array.isArray(ledgerRaw) || ledgerRaw.length === 0) {
      throw new Error("classifier: ledger_entries must be a non-empty array");
    }
    const ledger_entries: LedgerEntry[] = ledgerRaw.map((row, i) => {
      const r = expectObject(row, `classifier.ledger_entries[${i}]`);
      return {
        debit: expectString(r.debit, `classifier.ledger_entries[${i}].debit`),
        credit: expectString(r.credit, `classifier.ledger_entries[${i}].credit`),
        amount: expectNumber(r.amount, `classifier.ledger_entries[${i}].amount`),
        currency: expectString(r.currency, `classifier.ledger_entries[${i}].currency`),
      };
    });
    return {
      category: expectEnum(obj.category, CLASSIFIER_CATEGORIES, "classifier.category"),
      description: expectString(obj.description, "classifier.description"),
      vat_applicable: expectBoolean(obj.vat_applicable, "classifier.vat_applicable"),
      vat_amount: expectNumber(obj.vat_amount, "classifier.vat_amount"),
      deductible: expectBoolean(obj.deductible, "classifier.deductible"),
      ledger_entries,
      confidence: expectNumber(obj.confidence, "classifier.confidence"),
      warnings: expectStringArray(obj.warnings, "classifier.warnings"),
    };
  },
};

// ── Public API ─────────────────────────────────────────────────────────────

export interface ClassifierInput {
  /** A free-form operation description: invoice JSON, bank line, etc. */
  operation: Record<string, unknown>;
  /** Optional RAG chunks (tax-code / GAAP / Georgian VAT rules). */
  ragChunks?: StructuredAgentInput["ragChunks"];
}

export async function classifyOperation(
  input: ClassifierInput,
  opts: { gemini?: GeminiService } = {},
): Promise<StructuredAgentResult<ClassifierOutput>> {
  return runStructuredAgent(
    classifierAgent,
    {
      payload: input.operation,
      ragChunks: input.ragChunks,
    },
    opts,
  );
}
