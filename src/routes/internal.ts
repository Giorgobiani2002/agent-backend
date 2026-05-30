import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { findPlaybookByKey } from "../repositories/playbooks";
import { createBulkRun, markRunStarted } from "../repositories/bulkRuns";
import { spawnBulkWorker } from "./agent";
import { sendError } from "../utils/http";

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
      declaration_id?: string;
      playbook_key?: string;
      data?: Record<string, unknown>;
    };
    if (!body.declaration_id || typeof body.declaration_id !== "string") {
      throw new HttpError(400, "declaration_id is required");
    }
    const playbookKey = body.playbook_key || "rs.ge.vat-declaration";
    const data =
      body.data && typeof body.data === "object" && !Array.isArray(body.data)
        ? body.data
        : {};

    const playbook = await findPlaybookByKey(req.companyId, "GE", playbookKey);
    if (!playbook) {
      throw new HttpError(
        404,
        `No playbook with key="${playbookKey}" registered for this company. ` +
          `Record one via /dashboard/ai/playbooks and tag it with this key.`,
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
            declaration_id: body.declaration_id,
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
      safetyMode: "halt-on-dangerous" as const,
      allowedDomains: ["rs.ge"],
      sessionKey: "main_user",
      maxSteps: null,
      record: true,
      task: `Submit VAT declaration ${body.declaration_id}`,
      stopOnFailure: true,
      // Tags that the finalize hook uses to route the result back to
      // rs-server's /internal/declarations/:id/result endpoint.
      source: "declaration" as const,
      source_declaration_id: body.declaration_id,
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

export default router;
