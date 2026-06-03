import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { findPlaybookByKey } from "../repositories/playbooks";
import {
  createBulkRun,
  findActiveBulkRunForDeclaration,
  markRunStarted,
} from "../repositories/bulkRuns";
import { spawnBulkWorker } from "./agent";
import { sendError } from "../utils/http";
import { config } from "../config";

/**
 * Internal API surface that rs-server calls into. Today's only caller
 * is the declarations service: when a user clicks Submit on a VAT
 * declaration, rs-server POSTs here so agent-backend can:
 *
 *   1. Resolve the tenant's `rs.ge.vat-declaration` playbook.
 *   2. Create a one-row bulk_run carrying the declaration payload as
 *      the row's merged data (the Python worker reads it via the
 *      existing bulk-row claim API).
 *   3. Spawn a worker — via agent-runtime HTTP dispatch when
 *      AGENT_RUNTIME_URL is set (production), via local subprocess
 *      otherwise (dev).
 *
 * The run's config is tagged with `source: "declaration"` and
 * `source_declaration_id` so the bulk-run finalize hook in
 * routes/agent.ts can POST results back to rs-server's
 * /internal/declarations/:id/result endpoint, flipping the UI to
 * "Submitted" / "Failed" without polling.
 *
 * Auth: this router is mounted under `tenantMiddleware` in index.ts,
 * so X-Internal-Secret + X-Company-Id are enforced before any handler
 * runs.
 */

const router = Router();

router.post("/dispatch-declaration", async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as {
      // Generic submission dispatch. source_type + source_id identify
      // what's being filed (declaration | payroll | future income/profit
      // tax); result_path is the rs-server internal base path the
      // finalize hook posts the outcome to. declaration_id is kept as a
      // backward-compatible alias for the original VAT flow.
      source_type?: string;
      source_id?: string;
      result_path?: string;
      declaration_id?: string;
      playbook_key?: string;
      data?: Record<string, unknown>;
      // Safety mode for the run. Defaults to halt-on-dangerous (stop before
      // the final submit). Payroll passes "auto" for zero-touch submission.
      safety_mode?: "auto" | "halt-on-dangerous" | "dry-run";
    };
    const SAFETY_MODES = ["auto", "halt-on-dangerous", "dry-run"] as const;
    const safetyMode = (SAFETY_MODES as readonly string[]).includes(body.safety_mode ?? "")
      ? (body.safety_mode as (typeof SAFETY_MODES)[number])
      : ("halt-on-dangerous" as const);
    const sourceType = body.source_type || "declaration";
    const sourceId = body.source_id || body.declaration_id;
    const resultPath =
      body.result_path ||
      (sourceType === "declaration" ? "/internal/tools/declarations" : "");
    if (!sourceId || typeof sourceId !== "string") {
      throw new HttpError(400, "source_id (or declaration_id) is required");
    }
    if (!resultPath) {
      throw new HttpError(400, "result_path is required for non-declaration sources");
    }
    const playbookKey = body.playbook_key || "rs.ge.vat-declaration";
    const data =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? body.data
        : {};

    // Idempotency: if a non-terminal run already exists for this source,
    // return it instead of spawning a duplicate browser submission
    // (defends against an rs-server → agent-backend retry).
    const existingRun = await findActiveBulkRunForDeclaration(
      req.companyId,
      sourceId,
    );
    if (existingRun) {
      res.status(202).json({
        success: true,
        bulk_run_id: existingRun.id,
        idempotent: true,
      });
      return;
    }

    const playbook = await findPlaybookByKey(req.companyId, "GE", playbookKey);

    // ── Autonomous fallback (free mode) ──────────────────────────────
    // When no playbook is registered, optionally dispatch the same
    // task to agent-runtime's /run-task endpoint. browser-use will
    // drive Chromium step-by-step from the synthesized natural-
    // language task. Slower and pricier than a recorded playbook,
    // but works on day one without any user setup.
    //
    // Off by default (security: AI clicks around in tenant's rs.ge
    // account). Flip ALLOW_AUTONOMOUS_DISPATCH=true on agent-backend
    // to enable.
    if (!playbook && process.env.ALLOW_AUTONOMOUS_DISPATCH === "true") {
      const taskPrompt = buildAutonomousTaskPrompt(playbookKey, data);
      const runtimeUrl = process.env.AGENT_RUNTIME_URL?.replace(/\/$/, "");
      if (!runtimeUrl) {
        throw new HttpError(
          500,
          "ALLOW_AUTONOMOUS_DISPATCH is on but AGENT_RUNTIME_URL is not set",
        );
      }
      const correlationId = `auto-${sourceId}-${Date.now()}`;
      // Hand the worker enough to post its result back to the right
      // place: source id/type + the rs-server result path.
      const taskData = {
        ...data,
        source_id: sourceId,
        source_type: sourceType,
        result_path: resultPath,
      };
      let runtimeResp: globalThis.Response;
      try {
        runtimeResp = await fetch(`${runtimeUrl}/run-task`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Secret": config.aiInternalSecret,
          },
          body: JSON.stringify({
            task: taskPrompt,
            data: taskData,
            company_id: req.companyId,
            correlation_id: correlationId,
            max_steps: Number(process.env.AUTONOMOUS_MAX_STEPS ?? 80),
            safety_mode: "halt-on-dangerous",
          }),
        });
      } catch (err) {
        throw new HttpError(
          502,
          `Autonomous dispatch to agent-runtime failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      if (runtimeResp.status !== 202) {
        const errText = await runtimeResp.text().catch(() => "");
        throw new HttpError(
          502,
          `agent-runtime /run-task returned ${runtimeResp.status}: ${errText.slice(0, 200)}`,
        );
      }
      // No bulk_run tracking for autonomous mode (the worker doesn't
      // claim from bulk_run_rows). We return the correlation_id as
      // bulk_run_id so rs-server stores it on playbook_run_id — UI
      // shows "Submitted via autonomous AI" with this id for audit.
      // TODO: wire a /agent/task-callback/:correlationId endpoint so
      // status flips automatically when the worker finishes.
      res.status(202).json({
        success: true,
        bulk_run_id: correlationId,
        playbook_id: null,
        mode: "autonomous",
      });
      return;
    }

    if (!playbook) {
      throw new HttpError(
        404,
        `No playbook with key="${playbookKey}" registered for this company. ` +
          `Record one via /dashboard/ai/playbooks and tag it with this key. ` +
          `(Or enable ALLOW_AUTONOMOUS_DISPATCH=true to let the AI agent ` +
          `figure it out without a playbook — slower and pricier.)`,
      );
    }
    if (
      playbook.review_status !== "reviewed" ||
      (Array.isArray(playbook.steps) && playbook.steps.length === 0)
    ) {
      throw new HttpError(
        400,
        `Playbook "${playbookKey}" exists but is not reviewed/empty. ` +
          `Open it in /dashboard/ai/playbooks, review, and mark as ready.`,
      );
    }

    const rows = [
      {
        row_index: 0,
        playbook_id: playbook.id,
        data: {
          merged: data,
          raw: {
            source_id: sourceId,
            source_type: sourceType,
            dispatched_at: new Date().toISOString(),
          },
        },
      },
    ];

    const runConfig = {
      mode: "bulk" as const,
      sharedData: {},
      mapping: {},
      playbookColumn: null,
      playbookMap: {},
      defaultPlaybookId: null,
      safetyMode,
      allowedDomains: ["rs.ge"],
      sessionKey: "main_user",
      maxSteps: null,
      record: true,
      task: `Submit ${sourceType} ${sourceId}`,
      stopOnFailure: true,
      // Tags the finalize hook uses to POST the outcome back to the
      // right rs-server endpoint: `${result_path}/${source_id}/result`.
      source: sourceType,
      source_id: sourceId,
      result_path: resultPath,
      // Kept for backward-compat with any in-flight VAT runs.
      source_declaration_id: sourceType === "declaration" ? sourceId : undefined,
      playbookName: playbook.name,
    };

    const bulkRun = await createBulkRun({
      companyId: req.companyId,
      config: runConfig,
      rows,
    });
    const procs = spawnBulkWorker(bulkRun.id, req.companyId);
    await markRunStarted(bulkRun.id, procs[0]?.pid ?? 0);

    res.status(202).json({
      success: true,
      bulk_run_id: bulkRun.id,
      playbook_id: playbook.id,
    });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * Build a natural-language task prompt for browser-use's autonomous
 * (free) mode, given the playbook key + data the playbook would have
 * received. The prompt has to be specific enough that a generalist
 * LLM can navigate rs.ge without prior context — concrete URL, exact
 * form name (Form 200.00), and the numeric values to enter.
 *
 * Per playbook key we emit a different prompt. Only the VAT
 * declaration is wired today; add more cases as the playbook
 * library grows.
 */
function buildAutonomousTaskPrompt(
  playbookKey: string,
  data: Record<string, unknown>,
): string {
  if (playbookKey === "rs.ge.vat-declaration") {
    const year = data.period_year ?? "?";
    const month = data.period_month ?? "?";
    const outputVat = data.output_vat ?? 0;
    const inputVat = data.input_vat ?? 0;
    const netVat = data.net_vat ?? 0;
    const sales = data.taxable_sales_total ?? 0;
    const purchases = data.taxable_purchases_total ?? 0;
    return [
      "Open https://eservices.rs.ge in a fresh browser.",
      "Log in with the credentials available in the browser profile (already saved).",
      "Navigate to the VAT declaration section (დღგ — დეკლარაცია).",
      `Open a new VAT declaration (Form 200.00) for period ${year}-${String(month).padStart(2, "0")} (Year ${year}, Month ${month}).`,
      "Fill in the declaration using the following values (all amounts in GEL):",
      `  - Taxable sales (output base): ${sales}`,
      `  - VAT collected on sales (output VAT): ${outputVat}`,
      `  - Deductible purchases (input base): ${purchases}`,
      `  - Deductible VAT on purchases (input VAT): ${inputVat}`,
      `  - Net VAT payable: ${netVat}`,
      "Review the numbers match the form fields. If a field is auto-calculated by rs.ge and differs from these by more than 0.05 GEL, stop and report the mismatch.",
      "Click Save → then Submit (გაგზავნა / წარდგენა).",
      "Wait for the confirmation page. Copy the receipt number / declaration number.",
      "Return the receipt number in the form `receipt=<number>` as the last line of your output.",
    ].join("\n");
  }
  // Generic fallback — the playbook key tells us nothing specific.
  return `Execute the rs.ge flow identified as "${playbookKey}" using this data: ${JSON.stringify(
    data,
  )}. Log into rs.ge, find the relevant form, fill it, and submit. Return any receipt number on the last line as receipt=<number>.`;
}

export default router;
