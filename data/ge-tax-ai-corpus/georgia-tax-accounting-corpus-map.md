# Georgia Tax and Accounting Corpus Map for Declario Agents

Purpose: this document tells Declario's structured agents which source families to prefer when classifying Georgian operations, reasoning about tax, and planning rs.ge actions.

## Source Priority

1. Current consolidated Georgian Tax Code on Matsne.
   Use for legal definitions, taxpayer duties, VAT/profit/income/excise/import/property tax scope, penalties, limitation periods, and appeal logic.
   Source: https://matsne.gov.ge/ka/document/view/1043717

2. Minister of Finance Order No. 996 on tax administration.
   Use for declaration forms, return filing procedure, tax administration workflows, applications, annexes, and procedural implementation details.
   Source: https://www.matsne.gov.ge/en/document/view/1167887

3. Law of Georgia on Funded Pensions.
   Use for employee, employer, and State pension contribution rules, participant status, contribution base, and pension-specific payroll obligations.
   Source: https://matsne.gov.ge/en/document/view/4280127

4. Revenue Service / rs.ge operational materials.
   Use for portal-specific procedures, e-invoice, waybill, taxpayer information, VAT declaration, payment, and service-user behavior.
   Source: https://www.rs.ge and related rs.ge service portals.

5. SARAS standards and accounting law.
   Use for bookkeeping and financial reporting framework selection: IFRS, IFRS for SMEs, Category IV entity standard, annual reporting duties, and entity size-category rules.
   Sources:
   - https://www.saras.gov.ge/en/Home/IfrsForSmes
   - https://matsne.gov.ge/ka/document/view/3311504
   - https://www.saras.gov.ge/Content/files/meotxe-kategoriis-sawarmoebis-finansuri.pdf

6. IFRS Foundation materials.
   Use for global IFRS for SMEs framework, but do not override Georgian tax law or SARAS adoption rules. The 2025 IFRS for SMEs edition is effective for periods beginning on or after 2027-01-01, with early adoption possible where allowed.
   Source: https://www.ifrs.org/content/ifrs/home/issued-standards/ifrs-for-smes.html

7. rs-mcp repository documentation.
   Use for tool names, CLI commands, required inputs, destructive-operation safety, and mapping structured tax decisions into executable rs.ge actions.
   Source: https://github.com/Parsa-29/rs-mcp

## Agent-Specific Use

Accounting Classifier:
- Prefer SARAS / IFRS for SMEs for bookkeeping categories and ledger treatment.
- Prefer the Tax Code only when deciding tax classification or VAT treatment.
- If a transaction lacks date, counterparty TIN, VAT registration status, amount, currency, or document reference, lower confidence and add warnings.

Georgian Tax Reasoning:
- Prefer current Tax Code and Order No. 996.
- Cite source chunks for VAT status, tax risk, declaration effect, and filing period.
- If a legal claim is not grounded in retrieved chunks, use `unknown`, `medium` risk, or `submit_after_review`.

RS Action Planner:
- Prefer rs-mcp docs and current Declario playbook keys.
- Never invent taxpayer IDs, invoice IDs, waybill IDs, declaration sequence numbers, or service-user IDs.
- Any write/send/confirm/reject/delete action is non-reversible unless the source tool explicitly states it is only a draft save.

Human Approval Gate:
- Block low confidence, medium/high tax risk, irreversible rs.ge actions, unusual amount deltas, and large declaration deltas.
- Agent warnings are non-blocking by default but should be visible in the audit trail.

## Recommended Full-Text Corpus to Add Next

High priority:
- Current consolidated Georgian Tax Code from Matsne.
- Current consolidated Order No. 996 from Matsne.
- RS.ge user manuals for VAT declaration, invoices, waybills, taxpayer dashboard, and payments.
- SARAS Category IV standard.
- SARAS IFRS for SMEs Georgian translation if licensing/terms permit ingestion.

Medium priority:
- IFRS for SMEs official educational material and illustrative financial statements.
- Revenue Service public FAQs and video transcripts for VAT, waybills, e-invoices, and small business status.
- National Bank of Georgia exchange-rate rules and API documentation for foreign-currency conversion workflows.

Use caution:
- Commercial textbooks, ACCA paid materials, or copyrighted manuals should only be ingested when the user provides the file and confirms they have the right to use it.
