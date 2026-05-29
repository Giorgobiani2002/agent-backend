import os from "os";
import path from "path";
import fs from "fs/promises";
import multer from "multer";
import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { sendError } from "../utils/http";
import { playbookService } from "../services/playbook";
import {
  findPlaybookById,
  listPlaybooks,
  deletePlaybook,
  findLoginPlaybook,
  setPlaybookKey,
  setPlaybookKind,
  setPlaybookReviewStatus,
  updatePlaybookSteps,
  type PlaybookReviewStatus,
  type PlaybookStep,
} from "../repositories/playbooks";
import { deleteCachesForPlaybook } from "../repositories/playbookCache";
import { rebuildSiteMemoryForPlaybook } from "../services/siteMemoryDistiller";

const router = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), "declario-uploads"),
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/avi"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new HttpError(400, `Unsupported video type: ${file.mimetype}. Allowed: mp4, mov, webm, mkv`));
    }
  },
});

router.post("/upload-video", upload.single("video"), async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  try {
    if (!req.file) {
      throw new HttpError(400, "video file is required (field name: 'video')");
    }

    tempPath = req.file.path;
    const force = req.body.force === "true";

    const playbook = await playbookService.extractPlaybookFromUpload({
      companyId: req.companyId,
      filePath: path.normalize(tempPath),
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      force,
    });

    res.status(201).json({ success: true, playbook });
  } catch (error) {
    sendError(res, error);
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => {});
    }
  }
});

router.post("/from-youtube", async (req: Request, res: Response) => {
  try {
    const { url, force } = req.body ?? {};
    if (typeof url !== "string" || !url.trim()) {
      throw new HttpError(400, "url is required");
    }

    const playbook = await playbookService.extractPlaybookFromYoutube({
      companyId: req.companyId,
      url: url.trim(),
      force: force === true,
    });

    res.status(201).json({ success: true, playbook });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/", async (req: Request, res: Response) => {
  try {
    const playbooks = await listPlaybooks(req.companyId);
    res.json({ success: true, playbooks });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/login", async (req: Request, res: Response) => {
  try {
    const playbook = await findLoginPlaybook(req.companyId);
    if (!playbook) throw new HttpError(404, "No login playbook configured");
    res.json({ success: true, playbook });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const playbook = await findPlaybookById(req.companyId, req.params.id);
    if (!playbook) throw new HttpError(404, "Playbook not found");
    res.json({ success: true, playbook });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/:id", async (req: Request, res: Response) => {
  try {
    // Tenant guard: refuse early if the playbook isn't ours, otherwise the
    // by-id helpers below would happily mutate someone else's row.
    const owned = await findPlaybookById(req.companyId, req.params.id);
    if (!owned) throw new HttpError(404, "Playbook not found");

    const { kind, steps, reviewStatus, key } = req.body ?? {};
    let playbook = null;

    if (key !== undefined) {
      if (key !== null && typeof key !== "string") {
        throw new HttpError(400, "key must be a string or null");
      }
      const normalized =
        typeof key === "string"
          ? key.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "")
          : null;
      if (typeof key === "string" && (!normalized || normalized !== key.trim().toLowerCase())) {
        throw new HttpError(
          400,
          "key must contain only a-z, 0-9, dot, underscore, dash (e.g. 'rs.ge.invoice')",
        );
      }
      playbook = await setPlaybookKey(req.companyId, req.params.id, normalized);
      if (!playbook) throw new HttpError(404, "Playbook not found");
    }

    if (kind !== undefined) {
      if (kind !== "task" && kind !== "login") {
        throw new HttpError(400, "kind must be 'task' or 'login'");
      }
      playbook = await setPlaybookKind(req.params.id, kind);
      if (!playbook) throw new HttpError(404, "Playbook not found");
    }

    if (steps !== undefined) {
      if (!Array.isArray(steps)) throw new HttpError(400, "steps must be an array");
      const VALID_ACTIONS = new Set([
        "navigate", "click", "type", "select", "press", "wait", "upload", "assert",
      ]);
      const cleaned: PlaybookStep[] = [];
      for (const [i, s] of steps.entries()) {
        if (!s || typeof s !== "object") {
          throw new HttpError(400, `steps[${i}] must be an object`);
        }
        const step = s as Record<string, unknown>;
        const action = step.action;
        if (typeof action !== "string" || !VALID_ACTIONS.has(action)) {
          throw new HttpError(400, `steps[${i}].action must be one of: ${[...VALID_ACTIONS].join(", ")}`);
        }
        if (typeof step.target_description !== "string" || step.target_description.length === 0) {
          throw new HttpError(400, `steps[${i}].target_description is required`);
        }
        cleaned.push({
          index: i,
          action: action as PlaybookStep["action"],
          target_description: step.target_description,
          target_text: typeof step.target_text === "string" ? step.target_text : undefined,
          value: typeof step.value === "string" ? step.value : undefined,
          url: typeof step.url === "string" ? step.url : undefined,
          wait_ms: typeof step.wait_ms === "number" ? step.wait_ms : undefined,
          ts_start: typeof step.ts_start === "number" ? step.ts_start : 0,
          ts_end: typeof step.ts_end === "number" ? step.ts_end : 0,
          dangerous: typeof step.dangerous === "boolean" ? step.dangerous : undefined,
          danger_reason: typeof step.danger_reason === "string" ? step.danger_reason : undefined,
          evidence:
            step.evidence && typeof step.evidence === "object" && !Array.isArray(step.evidence)
              ? step.evidence as PlaybookStep["evidence"]
              : undefined,
        });
      }
      playbook = await updatePlaybookSteps(req.params.id, cleaned);
      if (!playbook) throw new HttpError(404, "Playbook not found");
    }

    if (reviewStatus !== undefined) {
      if (!["pending_review", "reviewed", "rejected"].includes(reviewStatus)) {
        throw new HttpError(400, "reviewStatus must be 'pending_review', 'reviewed', or 'rejected'");
      }
      playbook = await setPlaybookReviewStatus(req.params.id, reviewStatus as PlaybookReviewStatus);
      if (!playbook) throw new HttpError(404, "Playbook not found");
      if (reviewStatus === "rejected") {
        await deleteCachesForPlaybook(req.params.id);
      }
      // Phase Q1d: review-state changed → rebuild site memory for any
      // domain the playbook touches. Both reviewed and rejected trigger
      // a rebuild so the aggregated knowledge stays in sync (rejected
      // removes the playbook's contribution).
      if (reviewStatus === "reviewed" || reviewStatus === "rejected") {
        rebuildSiteMemoryForPlaybook(playbook).catch((err) =>
          console.error("[playbooks PATCH] site-memory rebuild failed (non-fatal):", err),
        );
      }
    }

    if (!playbook) throw new HttpError(400, "No fields to update (provide 'kind', 'steps', or 'reviewStatus')");
    res.json({ success: true, playbook });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const deleted = await deletePlaybook(req.companyId, req.params.id);
    if (!deleted) throw new HttpError(404, "Playbook not found");
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
