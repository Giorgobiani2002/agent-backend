import os from "os";
import path from "path";
import fs from "fs/promises";
import multer from "multer";
import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { booksService } from "../services/books";
import { asMetadata, platformAdminOnly, sendError } from "../utils/http";

// Knowledge base is global — only platform admins can mutate it. Reads
// (list, get, search) are open to any authenticated company user since the
// chat brain needs them.

const router = Router();

const upload = multer({
  dest: path.join(os.tmpdir(), "declario-books-uploads"),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB ceiling — bigger PDFs are rare here
  fileFilter: (_req, file, cb) => {
    const ok =
      file.mimetype === "application/pdf" ||
      file.originalname.toLowerCase().endsWith(".pdf");
    if (ok) cb(null, true);
    else cb(new HttpError(400, `Unsupported file type: ${file.mimetype}. Only PDF is accepted.`));
  },
});

function normalizeSourceType(metadata: Record<string, unknown>): string {
  const source = metadata.source;
  return typeof source === "string" && source.trim() ? source : "unknown";
}

function sourceLabel(sourceType: string): string {
  switch (sourceType) {
    case "api":
      return "Manual text";
    case "youtube_video":
      return "Video";
    case "youtube_transcript":
      return "Transcript";
    case "pdf":
      return "PDF";
    default:
      return "Imported";
  }
}

function isEditable(metadata: Record<string, unknown>): boolean {
  return normalizeSourceType(metadata) === "api";
}

function asChunkCount(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatBookSummary(book: {
  id: string;
  title: string;
  author: string | null;
  metadata: Record<string, unknown>;
  status: "pending" | "ready" | "failed";
  error: string | null;
  created_at: string;
  updated_at: string;
  chunk_count?: string;
}) {
  const sourceType = normalizeSourceType(book.metadata);

  return {
    id: book.id,
    title: book.title,
    author: book.author,
    status: book.status,
    error: book.error,
    created_at: book.created_at,
    updated_at: book.updated_at,
    chunk_count: asChunkCount(book.chunk_count),
    source_type: sourceType,
    source_label: sourceLabel(sourceType),
    editable: isEditable(book.metadata),
    metadata: book.metadata,
  };
}

router.post("/", platformAdminOnly, async (req: Request, res: Response) => {
  try {
    const { title, author, text, metadata } = req.body ?? {};

    if (typeof title !== "string" || typeof text !== "string") {
      throw new HttpError(400, "title and text are required");
    }

    const book = await booksService.createManualBook({
      title,
      author: typeof author === "string" ? author : undefined,
      text,
      metadata: asMetadata(metadata),
    });

    res.status(201).json({ success: true, book: formatBookSummary(book) });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/", async (_req: Request, res: Response) => {
  try {
    const books = await booksService.listKnowledgeBooks();
    res.status(200).json({ success: true, books: books.map(formatBookSummary) });
  } catch (error) {
    sendError(res, error);
  }
});

router.post(
  "/upload-pdf",
  platformAdminOnly,
  upload.single("file"),
  async (req: Request, res: Response) => {
    let tempPath: string | undefined;
    try {
      if (!req.file) {
        throw new HttpError(400, "PDF file is required (field name: 'file')");
      }
      tempPath = req.file.path;

      const titleField = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const authorField = typeof req.body?.author === "string" ? req.body.author.trim() : "";
      const force = req.body?.force === "true" || req.body?.force === true;

      const result = await booksService.ingestPdfBook({
        filePath: path.normalize(tempPath),
        title: titleField || req.file.originalname.replace(/\.pdf$/i, ""),
        author: authorField || undefined,
        metadata: { uploadedVia: "ui", originalName: req.file.originalname },
        force,
      });

      res.status(result.skipped ? 200 : 201).json({
        success: true,
        skipped: result.skipped,
        book: result.book,
      });
    } catch (error) {
      sendError(res, error);
    } finally {
      if (tempPath) {
        await fs.unlink(tempPath).catch(() => {});
      }
    }
  },
);

router.post("/import-data", platformAdminOnly, async (req: Request, res: Response) => {
  try {
    const force = req.body?.force === true;
    const result = await booksService.ingestPdfDirectory({ force });
    res.status(200).json({ success: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/:id", async (req: Request, res: Response) => {
  try {
    const detail = await booksService.getKnowledgeBook(req.params.id);

    if (!detail) {
      throw new HttpError(404, "Book not found");
    }

    const summary = formatBookSummary(detail.book);

    res.status(200).json({
      success: true,
      book: {
        ...summary,
        raw_text:
          summary.editable && typeof detail.book.metadata.rawText === "string"
            ? detail.book.metadata.rawText
            : undefined,
        chunks: detail.chunks.map((chunk) => ({
          id: chunk.id,
          chunk_index: chunk.chunk_index,
          content: chunk.content,
          token_count: chunk.token_count,
          char_count: chunk.char_count,
          metadata: chunk.metadata,
        })),
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.patch("/:id", platformAdminOnly, async (req: Request, res: Response) => {
  try {
    const { title, author, text, metadata } = req.body ?? {};

    if (typeof title !== "string" || typeof text !== "string") {
      throw new HttpError(400, "title and text are required");
    }

    const book = await booksService.updateManualBook({
      id: req.params.id,
      title,
      author: typeof author === "string" ? author : undefined,
      text,
      metadata: asMetadata(metadata),
    });

    res.status(200).json({ success: true, book: formatBookSummary(book) });
  } catch (error) {
    sendError(res, error);
  }
});

router.delete("/:id", platformAdminOnly, async (req: Request, res: Response) => {
  try {
    await booksService.deleteKnowledgeBook(req.params.id);
    res.status(200).json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

export default router;
