import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { sttService } from "../services/stt";

const router = Router();
const upload = multer({ dest: "tmp/" });

/**
 * POST /stt
 * Transcribes an audio file into text.
 * Multi-part form-data with a "file" field.
 */
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
    if (!req.file) {
        res.status(400).json({ success: false, message: "No file uploaded" });
        return;
    }

    const audioPath = req.file.path;

    try {
        const text = await sttService.transcribe(audioPath);
        res.json({ success: true, text });
    } catch (error: any) {
        console.error("[STT Route Error]", error);
        res.status(error.status || 500).json({
            success: false,
            message: error.message || "Failed to transcribe audio",
        });
    } finally {
        // Cleanup uploaded file
        if (fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
        }
    }
});

export default router;
