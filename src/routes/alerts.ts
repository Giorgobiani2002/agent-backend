import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import {
  countOpenAlertsBySeverity,
  getAlertById,
  listAlerts,
  setAlertStatus,
  type AlertSeverity,
  type AlertStatus,
} from "../repositories/alerts";
import { sendError } from "../utils/http";

const router = Router();

const ALL_STATUSES: AlertStatus[] = [
  "open",
  "acknowledged",
  "resolved",
  "snoozed",
];
const ALL_SEVERITIES: AlertSeverity[] = ["info", "warn", "critical"];

function parseList<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): T[] | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const good = parts.filter((p): p is T => (allowed as readonly string[]).includes(p));
  return good.length > 0 ? good : undefined;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const status = parseList(req.query.status, ALL_STATUSES);
    const severity = parseList(req.query.severity, ALL_SEVERITIES);
    const entityType = typeof req.query.entityType === "string" ? req.query.entityType : undefined;
    const entityId = typeof req.query.entityId === "string" ? req.query.entityId : undefined;
    const sinceHours = req.query.sinceHours ? Number(req.query.sinceHours) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;

    const rows = await listAlerts({
      companyId: req.companyId,
      status,
      severity,
      entityType,
      entityId,
      sinceHours: Number.isFinite(sinceHours as number) ? sinceHours : undefined,
      limit: Number.isFinite(limit as number) ? limit : undefined,
      offset: Number.isFinite(offset as number) ? offset : undefined,
    });

    res.json({ success: true, alerts: rows });
  } catch (error) {
    sendError(res, error);
  }
});

// Lightweight count for the topbar badge — polled every ~30s.
router.get("/count", async (req: Request, res: Response) => {
  try {
    const counts = await countOpenAlertsBySeverity(req.companyId);
    const total = counts.info + counts.warn + counts.critical;
    res.json({ success: true, counts, total });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const alert = await getAlertById(req.companyId, req.params.id);
    if (!alert) throw new HttpError(404, "Alert not found");
    res.json({ success: true, alert });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/acknowledge", async (req: Request, res: Response) => {
  try {
    const updated = await setAlertStatus({
      companyId: req.companyId,
      id: req.params.id,
      status: "acknowledged",
      reviewedBy: req.userId,
    });
    if (!updated) throw new HttpError(404, "Alert not found");
    res.json({ success: true, alert: updated });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/resolve", async (req: Request, res: Response) => {
  try {
    const updated = await setAlertStatus({
      companyId: req.companyId,
      id: req.params.id,
      status: "resolved",
      reviewedBy: req.userId,
    });
    if (!updated) throw new HttpError(404, "Alert not found");
    res.json({ success: true, alert: updated });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/:id/snooze", async (req: Request, res: Response) => {
  try {
    const { hours } = req.body ?? {};
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0 || h > 24 * 30) {
      throw new HttpError(400, "hours must be a positive number up to 720");
    }
    const until = new Date(Date.now() + h * 3600_000).toISOString();
    const updated = await setAlertStatus({
      companyId: req.companyId,
      id: req.params.id,
      status: "snoozed",
      snoozedUntil: until,
      reviewedBy: req.userId,
    });
    if (!updated) throw new HttpError(404, "Alert not found");
    res.json({ success: true, alert: updated });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
