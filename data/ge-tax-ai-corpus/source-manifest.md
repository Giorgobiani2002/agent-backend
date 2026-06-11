# Georgian tax & accounting corpus — authoritative source map

This is the canonical list of sources the Declario chat should be grounded in.
Public legislation is fetched from matsne.gov.ge (see `data/legal/matsne-manifest.json`
+ `npm run matsne:fetch`); copyrighted books/manuals are dropped into the folders
below by the operator. Each source is tagged with a `topic` so retrieval can
soft-boost the right material.

> The matsne document IDs below are best-effort and should be confirmed against
> the live consolidated version before relying on them. If an automatic fetch
> returns too little text (matsne pages can be JS-rendered), open the document on
> matsne.gov.ge, use its **PDF** export, and save it into `data/legal/<slug>.pdf`.

## Tier 1 — primary legislation (`topic: tax_law`)
- **საქართველოს საგადასახადო კოდექსი** (Tax Code) — VAT, income/profit tax, withholding, deadlines.
- **ფინანსთა მინისტრის ბრძანება №996** — tax administration procedures (declarations, waybills, e-invoices).
- **კანონი დაგროვებითი პენსიის შესახებ** — employee/employer/State pension contributions and contribution base.
- Customs Code / excise where relevant to e-commerce imports.

## Tier 2 — accounting & reporting (`topic: accounting_standard`)
- **კანონი ბუღალტრული აღრიცხვის, ანგარიშგებისა და აუდიტის შესახებ** (Law on Accounting, Reporting and Audit).
- **SARAS** category framework (I–IV) and which financial statements each category files.
- **IFRS for SMEs** (Georgian) — only if licensing permits redistribution; otherwise reference summaries only.

## Tier 3 — operational manuals (`topic: rs_manual`)
- rs.ge user guides: VAT declaration, e-invoice (ე-ინვოისი), waybill (ზედნადები), RS portal workflows.

## Tier 4 — already in repo
- `data/accounting/` — ACCA F1 distilled notes (`topic: accounting_book`, `language: en`).
- `data/ge-tax-ai-corpus/` — reasoning rules, standards map, rs-mcp guide (`topic: reference`).
- `templates/fino-library.json` — 234 Georgian primary-document templates (`topic: fino_template`), ingested via `npm run fino:ingest`.

## Drop folders (operator-supplied files: PDF / MD / TXT)
- `data/legal/` → `topic: tax_law`
- `data/accounting/` → `topic: accounting_book`
- `data/rs-manuals/` → `topic: rs_manual`

## Run order
```
npm run matsne:fetch     # acquire public legislation into data/legal/ (best-effort)
npm run fino:ingest      # 234 FINO templates
npm run corpus:ingest    # everything in the drop folders + repo corpora, idempotent
```
DOCX books are not parsed directly yet — convert to PDF or Markdown before dropping in
(the FINO library already has its own Python DOCX/XLSX parser in `templates/`).
