import path from "path";
import fs from "fs/promises";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";
import { config } from "../config";
import { HttpError } from "../errors";
import { downloadVideo, extractVideoId } from "../utils/youtube";
import { extractScreenshots } from "../utils/screenshots";
import {
  createPendingPlaybook,
  markPlaybookAnalyzing,
  markPlaybookReady,
  markPlaybookFailed,
  findPlaybookBySourcePath,
  type PlaybookRow,
  type PlaybookStep,
} from "../repositories/playbooks";

function getClient(): GoogleGenAI {
  if (!config.geminiApiKey) {
    throw new HttpError(503, "GEMINI_API_KEY is required");
  }
  return new GoogleGenAI({ apiKey: config.geminiApiKey });
}

const PLAYBOOK_PROMPT = `You are watching a screen recording of a user performing a task on a web portal (likely the Georgian tax portal rs.ge or a similar government site).

Extract every distinct UI interaction as an ordered JSON array of steps. For each step capture:
- What the user did (clicked a button, typed text, navigated to a URL, selected a dropdown, waited, etc.)
- A clear description of the target element in plain language
- Any visible text label, button text, or field label associated with the target
- Any value the user typed or selected — replace any sensitive credentials with template variables: use \${username} for usernames/emails, \${password} for passwords, \${tin} or \${personal_id} for ID numbers, \${tax_period} for tax periods, \${amount} for monetary amounts, \${otp} for one-time codes
- The approximate timestamp in seconds where the action starts and ends in the video

CRITICAL — mark "dangerous" any step that is irreversible or has financial/legal consequences:
- Final form submission ("გაგზავნა", "submit", "send", "დადასტურება", "confirm")
- Payment / money transfer ("გადახდა", "pay")
- Deletion ("წაშლა", "delete", "remove")
- Document signing ("ხელმოწერა", "sign")
- Any action that finalizes a tax declaration, transfer, or contract

For each dangerous step set "dangerous": true and "danger_reason": "<short description in English of why>".
Intermediate clicks (navigation, opening forms, selecting options, typing values) are NOT dangerous — only the final irreversible action.

Focus on actionable UI steps only. Skip steps where the user is just reading or waiting passively (unless the wait is significant — more than 3 seconds — in which case include a "wait" step).

Return ONLY a JSON object in this exact format, no other text:
{
  "steps": [
    {
      "index": 0,
      "action": "navigate",
      "target_description": "browser address bar",
      "url": "https://rs.ge",
      "ts_start": 0.0,
      "ts_end": 2.5
    },
    {
      "index": 1,
      "action": "type",
      "target_description": "Username field",
      "target_text": "პირადი ნომერი",
      "value": "\${personal_id}",
      "ts_start": 5.0,
      "ts_end": 7.2
    },
    {
      "index": 2,
      "action": "click",
      "target_description": "Submit declaration button",
      "target_text": "დეკლარაციის გაგზავნა",
      "dangerous": true,
      "danger_reason": "Final submission of tax declaration",
      "ts_start": 120.0,
      "ts_end": 121.0
    }
  ]
}

Valid action values: "navigate", "click", "type", "select", "press", "wait", "upload", "assert"`;

const VALID_ACTIONS = new Set<PlaybookStep["action"]>([
  "navigate",
  "click",
  "type",
  "select",
  "press",
  "wait",
  "upload",
  "assert",
]);

const DANGEROUS_TEXT_RE =
  /submit|send|confirm|pay|delete|remove|sign|finali[sz]e|register|გაგზავნა|დადასტურება|გადახდა|წაშლა|ხელმოწერა|წარდგენა/i;

const SENSITIVE_VALUE_RE = /password|token|otp|secret|pin|username|email|პაროლი/i;

function looksDangerous(step: PlaybookStep): boolean {
  const blob = [
    step.action,
    step.target_description,
    step.target_text,
    step.value,
    step.danger_reason,
  ]
    .filter(Boolean)
    .join(" ");
  return DANGEROUS_TEXT_RE.test(blob);
}

function templatedValue(step: PlaybookStep): string | undefined {
  if (!step.value) return undefined;
  if (/\$\{\w+\}/.test(step.value)) return step.value;
  const blob = `${step.target_description} ${step.target_text ?? ""}`;
  if (SENSITIVE_VALUE_RE.test(blob)) {
    if (/otp|token/i.test(blob)) return "${otp}";
    if (/username|email/i.test(blob)) return "${username}";
    return "${password}";
  }
  return step.value;
}

export function normalizeExtractedSteps(rawSteps: unknown[]): { steps: PlaybookStep[]; warnings: string[] } {
  const warnings: string[] = [];
  const normalized: PlaybookStep[] = [];

  for (const [i, raw] of rawSteps.entries()) {
    const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    let action = typeof s.action === "string" ? s.action.toLowerCase() : "click";
    if (!VALID_ACTIONS.has(action as PlaybookStep["action"])) {
      warnings.push(`Step ${i + 1}: unsupported action "${action || "(empty)"}" normalized to click.`);
      action = "click";
    }

    const tsStart = typeof s.ts_start === "number" && Number.isFinite(s.ts_start) ? s.ts_start : 0;
    const tsEnd =
      typeof s.ts_end === "number" && Number.isFinite(s.ts_end)
        ? Math.max(s.ts_end, tsStart)
        : tsStart;
    const confidence =
      typeof s.confidence === "number" && Number.isFinite(s.confidence)
        ? Math.max(0, Math.min(1, s.confidence))
        : 0.65;

    const step: PlaybookStep = {
      index: normalized.length,
      action: action as PlaybookStep["action"],
      target_description: typeof s.target_description === "string" ? s.target_description.trim() : "",
      target_text: typeof s.target_text === "string" && s.target_text.trim() ? s.target_text.trim() : undefined,
      value: typeof s.value === "string" ? s.value : undefined,
      url: typeof s.url === "string" && s.url.trim() ? s.url.trim() : undefined,
      wait_ms: typeof s.wait_ms === "number" && Number.isFinite(s.wait_ms) ? s.wait_ms : undefined,
      ts_start: tsStart,
      ts_end: tsEnd,
      dangerous: s.dangerous === true,
      danger_reason: typeof s.danger_reason === "string" ? s.danger_reason : undefined,
      evidence: {
        timestampSeconds: (tsStart + tsEnd) / 2,
        screenshotUrl: null,
        confidence,
      },
    };

    if (!step.target_description && step.target_text) step.target_description = step.target_text;
    if (!step.target_description && step.action === "navigate" && step.url) {
      step.target_description = "Navigate to recorded URL";
    }
    if (!step.target_description) {
      step.target_description = `Recorded ${step.action} action`;
      warnings.push(`Step ${i + 1}: missing target description.`);
    }

    step.value = templatedValue(step);
    if (looksDangerous(step)) {
      step.dangerous = true;
      step.danger_reason = step.danger_reason || "Irreversible or legally significant final action";
    }

    const prev = normalized[normalized.length - 1];
    const key = JSON.stringify({
      action: step.action,
      target_description: step.target_description,
      target_text: step.target_text ?? "",
      value: step.value ?? "",
      url: step.url ?? "",
    });
    const prevKey = prev
      ? JSON.stringify({
          action: prev.action,
          target_description: prev.target_description,
          target_text: prev.target_text ?? "",
          value: prev.value ?? "",
          url: prev.url ?? "",
        })
      : "";
    if (prev && key === prevKey) {
      warnings.push(`Step ${i + 1}: duplicate adjacent action removed.`);
      continue;
    }
    normalized.push(step);
  }

  if (normalized.length > 0 && !normalized.some((s) => s.dangerous)) {
    const last = normalized[normalized.length - 1];
    if (looksDangerous(last)) {
      last.dangerous = true;
      last.danger_reason = last.danger_reason || "Likely final submission action";
    } else {
      warnings.push("No dangerous final action was detected; human review should confirm before use.");
    }
  }

  return {
    steps: normalized.map((s, i) => ({ ...s, index: i })),
    warnings,
  };
}

async function attachStepEvidence(
  videoPath: string,
  steps: PlaybookStep[],
  sourceKey: string,
): Promise<PlaybookStep[]> {
  if (!steps.length) return steps;
  const segments = steps.map((step, index) => ({
    index,
    startTime: step.ts_start,
    endTime: step.ts_end > step.ts_start ? step.ts_end : step.ts_start + 0.2,
    text: step.target_text ?? step.target_description,
  }));
  const frames = await extractScreenshots(videoPath, segments, `playbooks/${sourceKey}`).catch(() => []);
  const byIndex = new Map(frames.map((frame) => [frame.index, frame]));
  return steps.map((step, index) => {
    const frame = byIndex.get(index);
    return {
      ...step,
      evidence: {
        ...(step.evidence ?? {}),
        timestampSeconds: frame?.timestampSeconds ?? step.evidence?.timestampSeconds ?? (step.ts_start + step.ts_end) / 2,
        screenshotUrl: frame?.screenshotUrl ?? step.evidence?.screenshotUrl ?? null,
        warning:
          frame && !frame.screenshotUrl
            ? "Frame extraction/upload failed; review video timestamp manually."
            : step.evidence?.warning ?? null,
      },
    };
  });
}

async function pollUntilActive(
  ai: GoogleGenAI,
  fileName: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = await ai.files.get({ name: fileName });
    if ((file as any).state === "ACTIVE") return;
    if ((file as any).state === "FAILED") {
      throw new Error("Gemini file processing failed");
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for Gemini file to become ACTIVE");
}

async function analyzeVideoFile(
  filePath: string,
  mimeType: string,
  displayName: string,
): Promise<{ steps: PlaybookStep[]; model: string; warnings: string[] }> {
  const ai = getClient();

  const uploadResult = await ai.files.upload({
    file: filePath,
    config: { mimeType, displayName },
  });

  const fileName = (uploadResult as any).name as string;
  const fileUri = (uploadResult as any).uri as string;

  try {
    await pollUntilActive(ai, fileName);

    const response = await ai.models.generateContent({
      model: config.geminiPlaybookModel,
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri, mimeType } },
            { text: PLAYBOOK_PROMPT },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        temperature: 0,
      },
    });

    const raw = response.text?.trim() ?? "";
    if (!raw) throw new Error("Gemini returned empty response");

    let parsed: { steps: unknown[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Gemini response is not valid JSON: ${raw.slice(0, 200)}`);
    }

    if (!Array.isArray(parsed.steps)) {
      throw new Error("Gemini response missing 'steps' array");
    }

    const model = response.modelVersion ?? config.geminiPlaybookModel;
    const { steps, warnings } = normalizeExtractedSteps(parsed.steps);
    return { steps, model, warnings };
  } finally {
    await ai.files.delete({ name: fileName }).catch(() => {});
  }
}

export async function extractPlaybookFromUpload(input: {
  companyId: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  force?: boolean;
}): Promise<PlaybookRow> {
  const sha = crypto
    .createHash("sha256")
    .update(await fs.readFile(input.filePath))
    .digest("hex")
    .slice(0, 16);
  const sourcePath = `upload:${sha}`;

  if (!input.force) {
    const existing = await findPlaybookBySourcePath(input.companyId, sourcePath);
    if (existing?.status === "ready") return existing;
  }

  const name = path.basename(input.originalName, path.extname(input.originalName));
  const playbook = await createPendingPlaybook({
    companyId: input.companyId,
    name,
    sourceType: "upload",
    sourcePath,
    reviewStatus: "pending_review",
  });

  await markPlaybookAnalyzing(playbook.id);

  try {
    const { steps, model, warnings } = await analyzeVideoFile(
      input.filePath,
      input.mimeType,
      input.originalName,
    );
    const stepsWithEvidence = await attachStepEvidence(input.filePath, steps, `upload-${sha}`);
    return await markPlaybookReady(playbook.id, stepsWithEvidence, model, undefined, warnings);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await markPlaybookFailed(playbook.id, msg);
    throw error;
  }
}

export async function extractPlaybookFromYoutube(input: {
  companyId: string;
  url: string;
  force?: boolean;
}): Promise<PlaybookRow> {
  const videoId = extractVideoId(input.url);
  const sourcePath = `youtube:${videoId}`;

  if (!input.force) {
    const existing = await findPlaybookBySourcePath(input.companyId, sourcePath);
    if (existing?.status === "ready") return existing;
  }

  const videoDownload = await downloadVideo(videoId);
  const { title, videoPath } = videoDownload;

  const playbook = await createPendingPlaybook({
    companyId: input.companyId,
    name: title,
    sourceType: "youtube",
    sourcePath,
    sourceUrl: input.url,
    reviewStatus: "pending_review",
  });

  await markPlaybookAnalyzing(playbook.id);

  try {
    const { steps, model, warnings } = await analyzeVideoFile(
      videoPath,
      "video/mp4",
      `${title}.mp4`,
    );
    const stepsWithEvidence = await attachStepEvidence(videoPath, steps, `youtube-${videoId}`);
    const result = await markPlaybookReady(playbook.id, stepsWithEvidence, model, undefined, warnings);
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await markPlaybookFailed(playbook.id, msg);
    throw error;
  } finally {
    await videoDownload.cleanup().catch(() => {});
  }
}

export const playbookService = { extractPlaybookFromUpload, extractPlaybookFromYoutube };
