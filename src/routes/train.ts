import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { videoService } from "../services/video";
import { playbookService } from "../services/playbook";
import { sendError } from "../utils/http";

const router = Router();

router.post("/video", async (req: Request, res: Response) => {
  try {
    const { url, force, createKnowledge, createPlaybook } = req.body ?? {};

    if (typeof url !== "string" || !url.trim()) {
      throw new HttpError(400, "url is required");
    }

    // Knowledge from a video is global → only platform admins create it.
    // Regular company users can still extract a playbook (per-company).
    const wantsKnowledge = createKnowledge !== false;
    const shouldCreateKnowledge = wantsKnowledge && req.isPlatformAdmin;
    if (wantsKnowledge && !req.isPlatformAdmin) {
      // Don't reject — just silently demote, so the same UI form keeps working
      // for company users (they get a playbook). Surface the demotion in the
      // response so the client can show a hint if it cares.
    }
    const shouldCreatePlaybook = createPlaybook !== false;

    if (!shouldCreateKnowledge && !shouldCreatePlaybook) {
      throw new HttpError(400, "At least one of createKnowledge or createPlaybook must be enabled");
    }

    const result = shouldCreateKnowledge
      ? await videoService.ingestVideo({
          url: url.trim(),
          force: force === true,
        })
      : null;

    const playbook = shouldCreatePlaybook
      ? await playbookService.extractPlaybookFromYoutube({
          companyId: req.companyId,
          url: url.trim(),
          force: force === true,
        })
      : null;

    const skipped = result?.skipped === true && !playbook;
    res.status(skipped ? 200 : 201).json({
      success: true,
      ...(result ?? {}),
      knowledge: result,
      playbook,
      reviewRequired: playbook?.review_status === "pending_review",
      knowledgeDeniedForCompanyUser: wantsKnowledge && !req.isPlatformAdmin,
    });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
