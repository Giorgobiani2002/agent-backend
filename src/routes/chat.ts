import { Router, Request, Response } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { HttpError, getErrorStatus } from "../errors";
import { chatService } from "../services/chat";
import { sttService } from "../services/stt";
import { ttsService } from "../services/tts";
import { asMetadata, sendError } from "../utils/http";

const router = Router();
const upload = multer({ dest: path.join(os.tmpdir(), "declario-voice-uploads") });

router.post("/conversations", async (req: Request, res: Response) => {
  try {
    const { userId, title, metadata } = req.body ?? {};
    const conversation = await chatService.createConversation({
      companyId: req.companyId,
      userId:
        typeof userId === "string" ? userId : req.userId ?? undefined,
      title: typeof title === "string" ? title : undefined,
      metadata: asMetadata(metadata),
    });

    res.status(201).json({ success: true, conversation });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/conversations", async (req: Request, res: Response) => {
  try {
    const userId =
      typeof req.query.userId === "string" ? req.query.userId : req.userId;
    const conversations = await chatService.listConversations(req.companyId, userId);
    res.status(200).json({ success: true, conversations });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/conversations/:id", async (req: Request, res: Response) => {
  try {
    const userId =
      typeof req.query.userId === "string" ? req.query.userId : req.userId;
    const deleted = await chatService.deleteConversation({
      companyId: req.companyId,
      id: req.params.id,
      userId,
    });

    if (!deleted) {
      throw new HttpError(404, "Conversation not found");
    }

    res.status(204).send();
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/conversations/:id/messages", async (req: Request, res: Response) => {
  try {
    const messages = await chatService.getMessages(req.params.id);
    res.status(200).json({ success: true, messages });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/conversations/:id/messages", async (req: Request, res: Response) => {
  try {
    const { content, metadata } = req.body ?? {};

    if (typeof content !== "string") {
      throw new HttpError(400, "content is required");
    }

    const result = await chatService.sendConversationMessage({
      companyId: req.companyId,
      conversationId: req.params.id,
      content,
      metadata: asMetadata(metadata),
      userId: req.userId,
    });

    res.status(201).json({
      success: true,
      userMessage: result.userMessage,
      assistantMessage: result.assistantMessage,
      contexts: result.contexts,
    });
  } catch (error) {
    if (getErrorStatus(error) >= 500) {
      console.error("[chat] POST /conversations/:id/messages failed:", error);
    }
    sendError(res, error);
  }
});

router.post("/stt", upload.single("file"), async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  try {
    if (!req.file) {
      throw new HttpError(400, "Audio file is required (field name: 'file')");
    }
    tempPath = req.file.path;

    const text = await sttService.transcribe(tempPath);
    res.status(200).json({ success: true, text });
  } catch (error) {
    sendError(res, error);
  } finally {
    if (tempPath) {
      await fs.unlink(tempPath).catch(() => { });
    }
  }
});

router.post("/tts", async (req: Request, res: Response) => {
  try {
    const { text } = req.body ?? {};
    if (typeof text !== "string" || !text.trim()) {
      throw new HttpError(400, "text is required");
    }

    const audioBuffer = await ttsService.synthesize(text);
    res.set({
      "Content-Type": "audio/wav",
      "Content-Length": audioBuffer.length,
    });
    res.status(200).send(audioBuffer);
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
