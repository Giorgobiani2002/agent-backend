# rs-mcp Operational Guide for Declario

Source repository: https://github.com/Parsa-29/rs-mcp

rs-mcp exposes Georgia Revenue Service APIs as both MCP tools and a CLI. It covers WayBill, Invoice / NTOS, TaxPayer, reference data, helper calls, and confirmation tools. The same repository also ships a Claude-style skill with detailed references.

## Authentication

Environment variables:
- `RS_SU`: service username, commonly in `username:TIN` form.
- `RS_SP`: service password.
- `RS_USER_ID`: numeric e-declaration user ID for invoice tools.
- `RS_BASE_URL`: WayBill SOAP endpoint.
- `RS_INVOICE_URL`: Invoice / NTOS SOAP endpoint.
- `RS_TAX_URL`: TaxPayer SOAP endpoint.

Declario must treat these as secrets. They should never be included in prompts, RAG chunks, logs, or agent audit summaries.

## Tool Families

Waybill:
- Read a waybill, list seller waybills, list buyer waybills, list updated waybills, filter by status/type/date/TIN.
- Save waybill draft or update an existing waybill.
- Send/activate, confirm, reject, close, delete draft, or cancel active waybill.

Invoice / NTOS:
- Look up NTOS user IDs, taxpayer IDs, TINs, names, credentials, and excise codes.
- Get, print, list, search, and inspect invoice line items / linked waybills.
- Save invoice, save invoice with note, save advance invoice.
- Change invoice status, accept, reject, correct, attach to VAT declaration.
- Save/delete line items, link/unlink waybills, manage reminders.

Taxpayer:
- Public taxpayer info, contacts, payer details, legal entity details, income data, NACE codes, GITA information.
- Z-report, waybill monthly amounts, financial dashboard, act of comparison, customs reports.
- Some detailed methods require SMS verification and explicit activation.

Reference and helpers:
- Waybill types, units, transport types, excise codes, wood types.
- TIN lookup, service-user credential check, service-users list, waybill error codes.

Confirmation:
- Destructive MCP operations queue a pending action.
- The tool returns `pending_confirmation` and an `action_id`.
- The user must approve explicitly.
- Execution requires `confirm_action` with `confirmation_text: "CONFIRM"`.
- Declario agents must never auto-confirm.

## Declario Planning Rules

Map actions conservatively:
- Taxable sale with sufficient buyer/seller data can plan `rs.ge.invoice`.
- Goods transport can plan `rs.ge.waybill` draft first, then `rs.ge.waybill_activate` only after review.
- Missing TIN, missing NTOS unique ID, missing waybill ID, missing invoice ID, or ambiguous operation date must become `required_inputs`, not invented values.

Draft saves:
- Saving a draft invoice or waybill can be reversible only if the tool and portal state clearly keep it as a draft.

Irreversible actions:
- Send/activate waybill.
- Confirm/reject buyer receipt.
- Close/cancel/delete where the portal changes external state.
- Accept/reject/change invoice status.
- Attach invoice to declaration.
- Customs warehouse exit.

Approval:
- Any irreversible action should be blocked by the Human Approval Gate until a human reviews the exact preview.
- If rs-mcp returns its own HITL pending preview, Declario should show that preview to the user and wait for explicit approval.

CLI examples useful for scripts:
- `rs-cli reference waybill-types`
- `rs-cli reference units`
- `rs-cli waybill get <id>`
- `rs-cli waybill list --from <YYYY-MM-DD> --to <YYYY-MM-DD>`
- `rs-cli waybill send <id>`
- `rs-cli invoice ntos-my-id`
- `rs-cli invoice seller-list --un-id <id> --from <YYYY-MM-DD> --to <YYYY-MM-DD>`
- `rs-cli invoice get <id>`
- `rs-cli taxpayer info <tin>`
- `rs-cli taxpayer dashboard`

## Integration Shape

Declario RS Action Planner should output:
- Action type.
- Priority.
- `playbook_key` or future `mcp_tool_name`.
- Required inputs.
- Reversibility.
- Human-readable description.

Future extension:
- Add an adapter that maps planner actions to exact rs-mcp tool calls.
- Keep destructive calls two-phase: plan -> preview -> human confirmation -> execute.
