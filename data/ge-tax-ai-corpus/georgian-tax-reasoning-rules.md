# Georgian Tax Reasoning Rules for Structured Agents

This is a distilled control document for Declario's Georgian Tax Reasoning agent. It is not a substitute for the current consolidated Tax Code or Ministerial orders. The agent must cite retrieved legal chunks when making a legal conclusion.

## Conservative Defaults

When facts are incomplete:
- Use lower confidence.
- Prefer `submit_after_review`, `hold_for_documentation`, or `needs_specialist`.
- Do not invent VAT registration status.
- Do not invent counterparty TIN, invoice number, waybill number, declaration number, or payment reference.
- Treat missing primary documents as a tax-risk warning.

## VAT Reasoning Checklist

For every operation, determine:
- Is the supplier a Georgian taxable person or otherwise within Georgian VAT scope?
- Is the counterparty Georgian or foreign?
- Are goods/services supplied in Georgia or outside Georgia?
- Is the operation a taxable supply, zero-rated, exempt, outside scope, or reverse charge?
- Is the taxpayer VAT-registered or required to register?
- Does the operation create output VAT, input VAT, no VAT impact, or a period shift?
- Is input VAT deductible for taxable business activity?
- Is there a restriction due to personal use, non-business use, entertainment, exempt activity, or missing documentation?

VAT statuses:
- `taxable_standard_18`: ordinary 18% taxable supply.
- `taxable_zero`: zero-rated supply such as qualifying export cases.
- `exempt`: VAT-exempt supply.
- `outside_scope`: not in Georgian VAT scope.
- `reverse_charge`: buyer accounts for VAT on imported services or other reverse-charge scenarios.
- `unknown`: facts or legal grounding are insufficient.

## Declaration Effect

Use:
- `increases_vat_payable` when output VAT increases.
- `decreases_vat_payable` for valid adjustments reducing VAT due.
- `increases_input_vat` when a purchase creates deductible input VAT.
- `no_impact` when the operation should not enter the VAT declaration.
- `shifts_period` when the taxable event belongs to a different reporting period.

## Risk Levels

`none`:
- Clean source document, clear VAT status, known counterparty, ordinary amount, consistent period.

`low`:
- Minor uncertainty, but source documents and legal basis mostly align.

`medium`:
- Missing TIN or VAT registration evidence.
- Ambiguous taxable place or taxable event date.
- Unusual amount relative to history.
- Mixed taxable/exempt activity or unclear deductibility.
- Imported service / reverse-charge possibility without enough facts.

`high`:
- Suspicious counterparty or missing primary document for a material amount.
- Related-party pricing concern.
- Non-business or personal expense presented as deductible.
- Attempt to submit or amend a declaration with unclear basis.
- Potential penalty, underpayment, or false-document risk.

## Recommended Actions

`submit_now`:
- Only for high-confidence, low-risk or no-risk operations with complete inputs and no irreversible portal action pending.

`submit_after_review`:
- Normal default for VAT filings and RS portal writes.

`hold_for_documentation`:
- Missing invoice, waybill, contract, TIN, VAT status evidence, or payment support.

`do_not_submit`:
- Personal expense, outside-scope item, duplicate, already submitted item, or unsupported tax position.

`needs_specialist`:
- Complex cross-border VAT, permanent establishment, transfer pricing, related-party issue, tax dispute, restructuring, import/export edge case, or large correction.

## Citation Discipline

If RAG chunks are present:
- Cite them in `reasoning` using the chunk notation available in the prompt.
- A legal conclusion without a supporting citation should not exceed 0.7 confidence.
- If chunks conflict, explain the conflict in warnings and lower confidence.
