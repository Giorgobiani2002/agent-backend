# Declario Accounting AI Roadmap

## Product Principle

"Teach the chat accounting" is not one model prompt or one fine-tune. A
production accounting assistant needs three separate layers:

1. Authoritative knowledge with source dates and citations.
2. Deterministic calculators and ledgers for amounts.
3. Tenant-scoped tools for live data and external actions.

The model should explain and orchestrate. It should not invent legal rules,
calculate material tax amounts in free text, or submit irreversible forms
without a preview and explicit approval.

## Current Foundation

- Global RAG corpus with Tax Code, Order No. 996, accounting references, FINO
  templates and source citations.
- Structured accounting classifier, Georgian tax-reasoning agent, RS action
  planner and approval gate.
- Deterministic VAT, payroll, profit-tax, journal and reporting modules.
- rs.ge SOAP tooling for waybills, invoices and taxpayer data.
- Browser playbooks for portal workflows that have no suitable published API.
- Chat tools for live company data, VAT drafting/auditing, payroll drafting,
  employee import and two-phase VAT/payroll filing.

## Source Priority

1. Current consolidated Matsne legislation.
2. Ministry of Finance orders and declaration annexes.
3. Revenue Service manuals, FAQs and published service descriptions.
4. SARAS standards and Georgian accounting law.
5. IFRS / IFRS for SMEs materials applicable to the entity category.
6. Licensed books and operator-provided training material.

Every source record should carry `sourceUrl`, version or fetch date, effective
date where available, language and topic. Commercial books must not be copied
into the shared corpus without usage rights.

## Coverage Plan

### P0: Payroll and Monthly Compliance

- Salary, withholding and funded-pension calculation.
- Employee master data and personal-number validation.
- Payroll declaration prepare, review, filing and receipt verification.
- Benefits in kind, exemptions, non-residents and corrections.
- Monthly deadline calendar and overdue alerts.

### P1: Core Bookkeeping

- Chart of accounts by entity framework.
- Sales, purchases, cash, bank, payroll, taxes and owner/equity postings.
- Bank reconciliation and duplicate detection.
- Receivables/payables aging and counterparty reconciliation.
- Period close checklist, trial balance, P&L, balance sheet and cash flow.

### P2: Georgian Taxes

- VAT including reverse charge, exemptions, zero rating and corrections.
- Distributed-profit tax and non-business/representation expenses.
- Small-business status and 1%/3% regimes.
- Withholding taxes and non-resident payments.
- Property, import, excise and customs workflows where relevant.

### P3: Accounting Standards

- Entity category and reporting-framework selection.
- Inventory and cost of sales.
- Fixed assets, useful lives, depreciation and disposal.
- Foreign currency and official exchange rates.
- Leases, provisions, impairment, revenue recognition and related parties.
- Annual SARAS reporting package and disclosure checklist.

## Action Safety Contract

- Read operations may run immediately.
- Draft creation may run immediately when reversible.
- Filing, sending, confirming, rejecting, deleting, paying or amending requires
  an exact preview and explicit user approval.
- Browser filing should default to `halt-on-dangerous`; the final submit stays
  under human control unless a separately approved zero-touch policy exists.
- Every action records company, user, period, inputs, calculator version,
  sources, preview, approval, runtime status and external receipt.

## Acceptance Tests Per Skill

- Golden examples reviewed by a Georgian accountant.
- Edge cases for exemptions, missing documents and corrections.
- Calculator tests independent of the LLM.
- Retrieval tests that require the correct current legal source.
- Tool tests for tenant isolation, idempotency and confirmation.
- End-to-end dry run against a test company before production filing.

## Immediate Gaps

- Chat attachments currently accept images only; salary XLSX parsing exists in
  the bulk-run UI but is not wired into the chat composer.
- Profit tax and small-business tax do not yet have complete chat calculators.
- The legal corpus needs scheduled refresh, change detection and effective-date
  awareness rather than manual refresh only.
- RS.ge payroll remains a browser-playbook workflow; published SOAP surfaces
  currently used by Declario cover waybills, invoices and taxpayer data.
