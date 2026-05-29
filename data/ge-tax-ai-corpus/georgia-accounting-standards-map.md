# Georgia Accounting Standards Map for Declario

This document guides the Accounting Classifier when choosing bookkeeping treatment before Georgian tax reasoning.

## Legal and Institutional Context

Georgia uses the Law of Georgia on Accounting, Reporting and Auditing for entity reporting obligations and framework selection.
Source: https://matsne.gov.ge/ka/document/view/3311504

SARAS is the Georgian authority for accounting, reporting, and auditing supervision.
Source: https://www.saras.gov.ge

IFRS Foundation jurisdiction materials state that Georgia adopted IFRS Standards for public interest and large entities, while SMEs generally use IFRS for SMEs unless they choose full IFRS. Micro / Category IV entities use simplified standards adopted by SARAS where applicable.
Source: https://www.ifrs.org/use-around-the-world/use-of-ifrs-standards-by-jurisdiction/view-jurisdiction/georgia/

SARAS publishes IFRS for SMEs materials in Georgian and Category IV standards.
Sources:
- https://www.saras.gov.ge/en/Home/IfrsForSmes
- https://www.saras.gov.ge/Content/files/meotxe-kategoriis-sawarmoebis-finansuri.pdf

## Framework Selection

Classify the entity before applying accounting rules:
- Public interest / large entities: full IFRS may be required.
- SME entities: IFRS for SMEs is generally the default framework.
- Category IV / micro entities: SARAS simplified Category IV standard may apply.
- Sector-specific rules can override the size-category default if a law or regulator requires another framework.

If the entity category is unknown, the classifier should:
- Use generic double-entry bookkeeping.
- Avoid detailed IFRS conclusions.
- Add a warning: "entity reporting framework unknown".

## Ledger Classification Priorities

Revenue:
- Sales revenue.
- Service revenue.
- Rental income.
- Interest income.
- Other income.

Expenses:
- Office expense.
- Rent.
- Utilities.
- Salaries and wages.
- Professional services.
- Marketing and advertising.
- Travel and subsistence.
- Transport and fuel.
- Inventory purchase.
- Fixed asset purchase.
- Interest and finance charges.
- Bank fees.
- Tax payment.

Equity / owner:
- Owner drawings.
- Shareholder contribution.

Non-P&L:
- Transfer between accounts.
- Suspense or uncategorised when facts are insufficient.

## Ledger Entry Discipline

For simple sales:
- Debit Accounts Receivable or Cash / Bank.
- Credit Sales Revenue or Service Revenue.
- Credit VAT Payable when VAT is included and separately tracked.

For simple purchases:
- Debit expense / inventory / fixed asset.
- Debit Input VAT Receivable when deductible and supported.
- Credit Accounts Payable or Cash / Bank.

For transfers:
- Debit receiving bank/cash account.
- Credit sending bank/cash account.
- VAT should normally be zero.

For salary payments:
- Debit Salary Expense.
- Credit Cash / Bank or Payables.
- Separate payroll tax withholding only when payroll details are available.

If VAT amount is embedded in gross amount:
- Standard VAT extraction at 18% from gross is gross * 18 / 118.
- Only compute when the tax reasoning facts support standard taxable treatment.

## Approval Warnings

Warn when:
- Counterparty TIN is missing.
- VAT registration status is missing.
- Operation date is missing.
- Currency is missing.
- Amount is zero, negative, or unusually large.
- Document number is missing for a tax-relevant operation.
- Expense may be personal or non-business.
- Entity framework is unknown.
