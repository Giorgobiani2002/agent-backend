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
import { getConversation } from "../repositories/chat";
import { createChatAttachment } from "../repositories/chat-attachments";
import { parsePayrollSpreadsheet } from "../utils/payroll-spreadsheet";
import { extractWaybillFromImage } from "../services/waybill-vision";

const router = Router();
const upload = multer({ dest: path.join(os.tmpdir(), "declario-voice-uploads") });
const spreadsheetUpload = multer({
  dest: path.join(os.tmpdir(), "declario-payroll-uploads"),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedName = /\.(xlsx|xlsm|csv)$/i.test(file.originalname);
    if (allowedName) cb(null, true);
    else cb(new HttpError(400, "Only .xlsx, .xlsm and .csv payroll files are supported"));
  },
});
const imageUpload = multer({
  dest: path.join(os.tmpdir(), "declario-image-uploads"),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new HttpError(400, "Only image files (JPEG / PNG / WebP) are supported"));
  },
});

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
    const conversation = await getConversation(req.companyId, req.params.id);
    if (!conversation) throw new HttpError(404, "Conversation not found");
    if (conversation.user_id && req.userId && conversation.user_id !== req.userId) {
      throw new HttpError(403, "Conversation belongs to another user");
    }
    const messages = await chatService.getMessages(req.params.id);
    res.status(200).json({ success: true, messages });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/conversations/:id/messages", async (req: Request, res: Response) => {
  try {
    const { content, metadata, attachmentIds } = req.body ?? {};

    if (typeof content !== "string") {
      throw new HttpError(400, "content is required");
    }
    if (
      attachmentIds !== undefined &&
      (!Array.isArray(attachmentIds) ||
        attachmentIds.some((id) => typeof id !== "string"))
    ) {
      throw new HttpError(400, "attachmentIds must be an array of ids");
    }

    const result = await chatService.sendConversationMessage({
      companyId: req.companyId,
      conversationId: req.params.id,
      content,
      metadata: asMetadata(metadata),
      userId: req.userId,
      attachmentIds: attachmentIds ?? [],
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

router.post(
  "/conversations/:id/attachments",
  spreadsheetUpload.single("file"),
  async (req: Request, res: Response) => {
    let tempPath: string | undefined;
    try {
      if (!req.file) {
        throw new HttpError(400, "Spreadsheet is required (field name: 'file')");
      }
      tempPath = req.file.path;
      const conversation = await getConversation(req.companyId, req.params.id);
      if (!conversation) throw new HttpError(404, "Conversation not found");
      if (conversation.user_id && req.userId && conversation.user_id !== req.userId) {
        throw new HttpError(403, "Conversation belongs to another user");
      }

      const parsed = await parsePayrollSpreadsheet(tempPath, req.file.originalname);
      const status =
        parsed.employees.length > 0 && parsed.columnMapping.name && parsed.columnMapping.gross
          ? "parsed"
          : "rejected";
      const attachment = await createChatAttachment({
        companyId: req.companyId,
        conversationId: req.params.id,
        userId: req.userId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype || "application/octet-stream",
        sizeBytes: req.file.size,
        status,
        parsedData: parsed as unknown as Record<string, unknown>,
      });

      res.status(201).json({
        success: true,
        attachment: {
          id: attachment.id,
          originalName: attachment.original_name,
          status: attachment.status,
          kind: attachment.kind,
          parsed,
        },
      });
    } catch (error) {
      sendError(res, error);
    } finally {
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
    }
  },
);

// Image (waybill photo) upload: extract the waybill fields at upload time —
// same pattern as the spreadsheet route, which parses the file before the
// chat turn reads `parsed_data`. The chat turn then builds the preview →
// confirm "send to rs.ge" card from these stored fields.
router.post(
  "/conversations/:id/attachments/image",
  imageUpload.single("file"),
  async (req: Request, res: Response) => {
    let tempPath: string | undefined;
    try {
      if (!req.file) {
        throw new HttpError(400, "Image is required (field name: 'file')");
      }
      tempPath = req.file.path;
      const conversation = await getConversation(req.companyId, req.params.id);
      if (!conversation) throw new HttpError(404, "Conversation not found");
      if (conversation.user_id && req.userId && conversation.user_id !== req.userId) {
        throw new HttpError(403, "Conversation belongs to another user");
      }

      const imageBase64 = (await fs.readFile(tempPath)).toString("base64");
      const extraction = await extractWaybillFromImage(
        imageBase64,
        req.file.mimetype || "image/jpeg",
      );

      // 'parsed' only when we actually recognized a waybill with line items;
      // otherwise 'rejected' so the chat turn can tell the user it couldn't
      // read a waybill rather than offering a bogus send button.
      const status = extraction.is_waybill && extraction.items.length > 0
        ? "parsed"
        : "rejected";

      const attachment = await createChatAttachment({
        companyId: req.companyId,
        conversationId: req.params.id,
        userId: req.userId,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype || "image/jpeg",
        sizeBytes: req.file.size,
        kind: "image",
        status,
        parsedData: extraction as unknown as Record<string, unknown>,
      });

      res.status(201).json({
        success: true,
        attachment: {
          id: attachment.id,
          originalName: attachment.original_name,
          status: attachment.status,
          kind: attachment.kind,
          extraction,
        },
      });
    } catch (error) {
      sendError(res, error);
    } finally {
      if (tempPath) await fs.unlink(tempPath).catch(() => {});
    }
  },
);

// Confirm + file a vision-extracted waybill to rs.ge. `approvalId` is the
// image attachment id (the source of truth for the extracted fields).
router.post(
  "/conversations/:id/waybill-approvals/:approvalId/confirm",
  async (req: Request, res: Response) => {
    try {
      const { snapshotHash } = req.body ?? {};
      const result = await chatService.confirmWaybillAction({
        companyId: req.companyId,
        conversationId: req.params.id,
        userId: req.userId,
        attachmentId: req.params.approvalId,
        snapshotHash: typeof snapshotHash === "string" ? snapshotHash : undefined,
      });
      res.status(200).json({ success: true, result });
    } catch (error) {
      sendError(res, error);
    }
  },
);

router.post(
  "/conversations/:id/payroll-approvals/:approvalId/confirm",
  async (req: Request, res: Response) => {
    try {
      const { payrollRunId, snapshotHash } = req.body ?? {};
      if (typeof payrollRunId !== "string" || typeof snapshotHash !== "string") {
        throw new HttpError(400, "payrollRunId and snapshotHash are required");
      }
      const result = await chatService.confirmPayrollAction({
        companyId: req.companyId,
        conversationId: req.params.id,
        userId: req.userId,
        payrollRunId,
        approvalId: req.params.approvalId,
        snapshotHash,
      });
      res.status(200).json({ success: true, result });
    } catch (error) {
      sendError(res, error);
    }
  },
);

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
