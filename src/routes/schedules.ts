import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { sendError } from "../utils/http";
import { findPlaybookById } from "../repositories/playbooks";
import {
  listScheduledRuns,
  findScheduledRunById,
  createScheduledRun,
  updateScheduledRun,
  deleteScheduledRun,
} from "../repositories/scheduledRuns";
import { computeNextRunAt, isValidCronExpression } from "../services/scheduler";

const router = Router();

const VALID_SAFETY = new Set(["auto", "halt-on-dangerous", "dry-run"]);

router.get("/", async (req: Request, res: Response) => {
  try {
    const rows = await listScheduledRuns(req.companyId);
    res.json({ success: true, schedules: rows });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const row = await findScheduledRunById(req.companyId, req.params.id);
    if (!row) throw new HttpError(404, "Schedule not found");
    res.json({ success: true, schedule: row });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/", async (req: Request, res: Response) => {
  try {
    const {
      name,
      playbookId,
      cronExpression,
      data = {},
      safetyMode = "auto",
      enabled = true,
      timezone = null,
    } = req.body ?? {};

    if (typeof name !== "string" || !name.trim()) throw new HttpError(400, "name is required");
    if (typeof playbookId !== "string" || !playbookId.trim()) {
      throw new HttpError(400, "playbookId is required");
    }
    if (typeof cronExpression !== "string" || !cronExpression.trim()) {
      throw new HttpError(400, "cronExpression is required");
    }
    if (!isValidCronExpression(cronExpression, timezone)) {
      throw new HttpError(400, "cronExpression is not a valid cron string");
    }
    if (!VALID_SAFETY.has(safetyMode)) {
      throw new HttpError(400, "safetyMode must be auto, halt-on-dangerous, or dry-run");
    }
    // The playbook must belong to this company too — otherwise you could
    // schedule against another tenant's playbook.
    const playbook = await findPlaybookById(req.companyId, playbookId);
    if (!playbook) throw new HttpError(400, `Unknown playbookId: ${playbookId}`);

    const nextAt = computeNextRunAt(cronExpression, timezone);
    if (!nextAt) throw new HttpError(400, "Could not compute next run time from cronExpression");

    const row = await createScheduledRun({
      companyId: req.companyId,
      name: name.trim(),
      playbookId,
      cronExpression: cronExpression.trim(),
      data: data as Record<string, unknown>,
      safetyMode,
      enabled,
      timezone,
      nextRunAt: nextAt,
    });

    res.status(201).json({ success: true, schedule: row });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const existing = await findScheduledRunById(req.companyId, id);
    if (!existing) throw new HttpError(404, "Schedule not found");

    const body = req.body ?? {};
    const cronExpression: string | undefined = body.cronExpression;
    const timezone: string | null | undefined = body.timezone;

    if (cronExpression !== undefined) {
      if (typeof cronExpression !== "string" || !cronExpression.trim()) {
        throw new HttpError(400, "cronExpression must be a non-empty string");
      }
      const tz = timezone === undefined ? existing.timezone : timezone;
      if (!isValidCronExpression(cronExpression, tz)) {
        throw new HttpError(400, "cronExpression is not a valid cron string");
      }
    }
    if (body.safetyMode !== undefined && !VALID_SAFETY.has(body.safetyMode)) {
      throw new HttpError(400, "safetyMode must be auto, halt-on-dangerous, or dry-run");
    }

    // Recompute next_run_at when cron changes, when re-enabling, or when caller
    // explicitly asks for it. Otherwise leave it alone.
    let nextRunAt: Date | null | undefined = undefined;
    const cronChanged = cronExpression !== undefined && cronExpression !== existing.cron_expression;
    const enabling = body.enabled === true && existing.enabled === false;
    if (cronChanged || enabling) {
      const tz = timezone === undefined ? existing.timezone : timezone;
      const cron = cronExpression ?? existing.cron_expression;
      nextRunAt = computeNextRunAt(cron, tz);
    }
    // Disabling clears the next run.
    if (body.enabled === false) nextRunAt = null;

    const updated = await updateScheduledRun(req.companyId, id, {
      name: body.name,
      cronExpression,
      data: body.data,
      safetyMode: body.safetyMode,
      enabled: body.enabled,
      timezone,
      nextRunAt,
    });
    res.json({ success: true, schedule: updated });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const ok = await deleteScheduledRun(req.companyId, req.params.id);
    if (!ok) throw new HttpError(404, "Schedule not found");
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /schedules/validate-cron ─────────────────────────────────────────────
// Quick check used by the create form to give live feedback while user types.
router.post("/validate-cron", (req: Request, res: Response) => {
  try {
    const { cronExpression, timezone } = req.body ?? {};
    if (typeof cronExpression !== "string") throw new HttpError(400, "cronExpression required");
    const valid = isValidCronExpression(cronExpression, timezone ?? null);
    if (!valid) {
      res.json({ success: true, valid: false });
      return;
    }
    const next = computeNextRunAt(cronExpression, timezone ?? null);
    res.json({ success: true, valid: true, nextRunAt: next?.toISOString() });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
