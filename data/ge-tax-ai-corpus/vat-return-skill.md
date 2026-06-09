---
title: VAT return drafting skill (დღგ-ის დეკლარაციის მონახაზი)
topic: reference
language: ka
---

# Skill: VAT return draft & explanation (დღგ)

## Purpose
Help a Georgian company **draft and understand its monthly VAT return** before
filing it. The assistant computes the period figures from invoices already synced
to declario and explains them in plain Georgian, grounded in the Tax Code.

This skill **drafts and explains only**. rs.ge has **no declaration API**, so the
actual VAT return is filed through the rs.ge web UI (later, via a browser
playbook + human confirmation) — never claim the return was "submitted".

## When to use
Trigger when the user asks anything like: „დამიდგინე/ამიხსენი დღგ", „ამ თვის დღგ
რამდენია?", "draft my VAT for 2026-05", „რა დღგ უნდა გადავიხადო?".

## Tool
Call **`draft_vat_return`** with `{ year, month }` (defaults to the current
period). It returns a VAT snapshot:
- `output_vat` — VAT on sales invoices (gross collected)
- `input_vat` — deductible VAT, from **ACCEPTED** purchase invoices only
- `net_vat` = `output_vat − input_vat` (payable if positive)
- `taxable_sales_total`, `taxable_purchases_total`, invoice counts, sample ids
- `warnings` — always read these out to the user

## Core concepts (cite the Tax Code from the knowledge base)
- **Standard VAT rate: 18%.** Output VAT = taxable turnover × 18%.
- **Net VAT payable = output VAT − input VAT.** Input VAT is deductible only on
  purchase invoices the company has **accepted** on rs.ge (`rs_status = 2`).
- **Monthly return** — the VAT declaration is filed and the tax paid by the
  **15th of the month following** the reporting period.
- Exempt / zero-rated supplies do not generate output VAT (`vat_exempt`).
Always pull the exact article numbers (e.g. VAT registration, deadlines) from the
retrieved Tax Code chunks and cite them — do not invent article numbers.

## Worked example
User: „2026 წლის მაისის დღგ დამიდგინე."
1. Call `draft_vat_return { year: 2026, month: 5 }`.
2. Snapshot: `output_vat = 4 320`, `input_vat = 1 180`, `net_vat = 3 140`,
   `invoice_count_sales = 27`, `warnings = []`.
3. Reply: „მაისის output დღგ — 4 320 ₾ (27 გაყიდვის ფაქტურა), გამოსაქვითი input
   დღგ — 1 180 ₾, **გადასახდელი net დღგ — 3 140 ₾**. ვადა: 15 ივნისი. (კოდექსი,
   მუხ. …). გაგზავნა rs.ge-ს პორტალზე ხდება — API არ არსებობს."

## Common pitfalls
- **Input VAT = 0 + a warning** → declario may not yet sync purchase (received)
  invoices. Tell the user to verify deductible VAT manually; do **not** present
  net VAT as final.
- **No sales invoices** → either no activity that month or invoices haven't
  synced — say so, don't report 0 as a confident answer.
- Never say "filed/submitted" — this skill only drafts. Filing is a separate
  rs.ge-UI step.
- Don't quote a Tax Code article number unless it appears in the retrieved
  context.

## Cross-references
- Backend tool: `draft_vat_return` → `GET /internal/tools/vat-preview` →
  `declarationsService.prepareVatFromInvoices` → `vat-calc.ts` (`computeVatSnapshot`).
- Related skills (future): `explain_income_tax`, `draft_profit_tax`, rs.ge
  submission playbook.
