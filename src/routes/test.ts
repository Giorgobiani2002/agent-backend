import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Test route is working",
    timestamp: new Date().toISOString(),
  });
});

export default router;
