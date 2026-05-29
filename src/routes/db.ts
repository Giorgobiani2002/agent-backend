import { Router, Request, Response } from "express";
import { getPgVectorStatus, initializePgVector } from "../db";

const router = Router();

router.get("/health", async (_req: Request, res: Response) => {
  try {
    await initializePgVector();
    const status = await getPgVectorStatus();

    res.status(200).json({
      success: true,
      ...status,
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      message: error instanceof Error ? error.message : "Database connection failed",
    });
  }
});

export default router;
