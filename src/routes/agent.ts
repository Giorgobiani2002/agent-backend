import os from "os";
import path from "path";
import fs from "fs/promises";
import { createHash } from "crypto";
import { spawn, ChildProcess } from "child_process";
import multer from "multer";
import ExcelJS from "exceljs";
import { Router, Request, Response } from "express";
import { HttpError } from "../errors";
import { config } from "../config";
import { geminiService } from "../services/gemini";
import { searchBookChunks, searchBookChunksWithNeighbors } from "../repositories/books";
import {
  findPlaybookById,
  findPlaybookByKey,
  listPlaybooks,
  type PlaybookRow,
} from "../repositories/playbooks";
import {
  computePlaybookVersion,
  findCacheByPlaybook,
  listCachesForPlaybook,
  listLatestCachesByPlaybook,
  upsertCache,
  type CachedAction,
} from "../repositories/playbookCache";
import { getPlaybookAnalytics, getAnalyticsSummary, getDailyTrend, getRecentFailures } from "../repositories/analytics";
import { getSiteMemory, listSiteMemoryDomains, normalizeDomain } from "../repositories/siteMemory";
import { rebuildSiteMemoryFor } from "../services/siteMemoryDistiller";
import {
  recordFailurePattern,
  listFailurePatterns,
  isFailureType,
} from "../repositories/failurePatterns";
import { notifyBulkRunComplete } from "../services/notifications";
import { analyzeFinancialOperation } from "../services/financial-agent-stack";
import { evaluateApproval } from "../services/approval-gate";
import {
  decideAgentRun,
  getAgentRunById,
  insertAgentRun,
  listAgentRuns,
  medianAmountByCategory,
  type AgentRunStatus,
} from "../repositories/agentRuns";
import {
  createBulkRun,
  findBulkRun,
  findBulkRunByIdInternal,
  findBulkRunWithRows,
  listBulkRuns,
  listBulkRunRowsAfter,
  claimNextPendingRow,
  updateRowResult,
  requeueRowForRetry,
  skipPendingRowsForStoppedRun,
  markRunStarted,
  markRunFinished,
  markRunCancelled,
  resetIncompleteRows,
  recordHeartbeat,
  findRunningRunsWithoutHeartbeat,
  markRunStalled,
  failRunningRowsForStalledRun,
  type BulkRunRowStatus,
} from "../repositories/bulkRuns";
import {
  isCompletionState,
  isSafetyMode,
  type ExecutionCompletionState,
  type SafetyMode,
} from "../types/execution";
import { formatQueryForEmbedding } from "../utils/chunking";
import { sendError } from "../utils/http";

const router = Router();

const excelUpload = multer({
  dest: path.join(os.tmpdir(), "declario-excel"),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/octet-stream",
    ];
    const okName = /\.(xlsx|xlsm|xls)$/i.test(file.originalname);
    if (allowed.includes(file.mimetype) || okName) {
      cb(null, true);
    } else {
      cb(new HttpError(400, `Unsupported spreadsheet type: ${file.mimetype}`));
    }
  },
});

interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

async function parseSpreadsheet(filePath: string): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) return { headers: [], rows: [] };

  // Find header row (first non-empty row)
  let headerRowIdx = 0;
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (!headerRowIdx) headerRowIdx = rowNumber;
  });
  if (!headerRowIdx) return { headers: [], rows: [] };

  const headerRow = sheet.getRow(headerRowIdx);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = String(cell.value ?? "").trim();
  });
  // Compact headers, drop empty trailing
  const cleanedHeaders = headers.map((h) => h ?? "").filter((h) => h.length > 0);
  if (!cleanedHeaders.length) return { headers: [], rows: [] };

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= headerRowIdx) return;
    const obj: Record<string, string> = {};
    let hasAny = false;
    for (let i = 0; i < cleanedHeaders.length; i++) {
      const cell = row.getCell(i + 1);
      const rawCell = cell.value as unknown;
      let extracted: unknown = rawCell;
      if (rawCell && typeof rawCell === "object") {
        if ("text" in rawCell) {
          extracted = (rawCell as { text: unknown }).text;
        } else if (rawCell instanceof Date) {
          extracted = rawCell.toISOString().slice(0, 10);
        } else if ("result" in rawCell) {
          extracted = (rawCell as { result: unknown }).result;
        } else if ("richText" in rawCell) {
          const parts = (rawCell as { richText: { text: string }[] }).richText;
          extracted = parts.map((p) => p.text).join("");
        }
      }
      const value = extracted == null ? "" : String(extracted).trim();
      obj[cleanedHeaders[i]] = value;
      if (value) hasAny = true;
    }
    if (hasAny) rows.push(obj);
  });

  return { headers: cleanedHeaders, rows };
}

// Path to the Python agent script relative to the backend working directory
const AGENT_SCRIPT = path.resolve(__dirname, "../../../agent/main.py");
const isWindows = process.platform === "win32";
const PYTHON_BIN = process.env.PYTHON_BIN ?? (isWindows ? "python" : "python3");
const BROWSER_USE_CONFIG_DIR = path.resolve(__dirname, "../../../agent/recordings/browseruse-config");
export type AgentMode = "free" | "playbook" | "bulk";
export const DEFAULT_AGENT_ALLOWED_DOMAINS = ["rs.ge"];
export const DEFAULT_AGENT_SESSION_KEY = "default";

export function normalizeAllowedDomains(value: unknown): string[] {
  const raw =
    Array.isArray(value)
      ? value
      : typeof value === "string"
        ? value.split(",")
        : DEFAULT_AGENT_ALLOWED_DOMAINS;
  const cleaned = raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .map((item) => item.replace(/^https?:\/\//, "").split("/")[0].split(":")[0])
    .filter((item) => item.length > 0);
  return [...new Set(cleaned.length ? cleaned : DEFAULT_AGENT_ALLOWED_DOMAINS)];
}

export function normalizeSessionKey(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const cleaned = raw.replace(/[^a-z0-9_.-]+/g, "_").slice(0, 80).replace(/^[._-]+|[._-]+$/g, "");
  return cleaned || DEFAULT_AGENT_SESSION_KEY;
}

function normalizeAgentMode(value: unknown, hasPlaybook: boolean): AgentMode {
  if (value === "bulk" || value === "playbook" || value === "free") return value;
  return hasPlaybook ? "playbook" : "free";
}

function defaultCompletionState(safetyMode: SafetyMode): ExecutionCompletionState {
  return safetyMode === "auto" ? "submitted" : "ready_for_review";
}

export function assertReviewedPlaybook(playbook: {
  id: string;
  review_status?: string;
  status?: string;
  steps?: unknown[];
}): void {
  if (playbook.status !== "ready") {
    throw new HttpError(409, `Playbook ${playbook.id} is not ready`);
  }
  if (playbook.review_status === "rejected") {
    throw new HttpError(409, "Playbook was rejected and cannot be used for automation");
  }
  if (playbook.review_status !== "reviewed") {
    throw new HttpError(409, "Playbook must be reviewed before it can be used for automation");
  }
  if (!Array.isArray(playbook.steps) || playbook.steps.length === 0) {
    throw new HttpError(409, "Playbook must contain at least one reviewed step before automation");
  }
}

function tokenizeTask(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3),
  );
}

export function scoreTaskAgainstPlaybook(
  task: string,
  playbook: {
    name?: string;
    steps?: Array<{
      action?: unknown;
      target_description?: unknown;
      target_text?: unknown;
      url?: unknown;
      value?: unknown;
    }>;
  },
): number {
  const taskTokens = tokenizeTask(task);
  if (!taskTokens.size) return 0;
  const haystack = [
    playbook.name ?? "",
    ...(playbook.steps ?? []).flatMap((step) => [
      typeof step.target_description === "string" ? step.target_description : "",
      typeof step.target_text === "string" ? step.target_text : "",
      typeof step.url === "string" ? step.url : "",
      typeof step.value === "string" ? step.value : "",
    ]),
  ].join(" ");
  const playbookTokens = tokenizeTask(haystack);
  let overlap = 0;
  for (const token of taskTokens) {
    if (playbookTokens.has(token)) overlap += 1;
  }

  const tokenScore = overlap / Math.max(taskTokens.size, 1);
  const taskLower = task.toLowerCase();
  const haystackLower = haystack.toLowerCase();
  const phraseBoost = taskLower.length >= 8 && haystackLower.includes(taskLower) ? 0.25 : 0;
  const portalBoost =
    /\brs\.ge\b|eservices\.rs\.ge/i.test(task) && /rs\.ge|eservices\.rs\.ge/i.test(haystack)
      ? 0.15
      : 0;
  return Math.min(1, tokenScore + phraseBoost + portalBoost);
}

async function compileTaskCandidate(input: {
  companyId: string;
  task: string;
  playbookId?: string;
}): Promise<{ playbookId: string; matched: boolean; score: number } | null> {
  if (input.playbookId) return { playbookId: input.playbookId, matched: false, score: 1 };
  const tokens = tokenizeTask(input.task);
  if (!tokens.size) return null;

  const reviewed = (await listPlaybooks(input.companyId)).filter(
    (playbook) =>
      playbook.kind === "task" &&
      playbook.status === "ready" &&
      playbook.review_status === "reviewed" &&
      Array.isArray(playbook.steps) &&
      playbook.steps.length > 0,
  );

  let best: { id: string; score: number } | null = null;
  for (const playbook of reviewed) {
    const score = scoreTaskAgainstPlaybook(input.task, playbook);
    if (!best || score > best.score) best = { id: playbook.id, score };
  }

  return best && best.score >= 0.35 ? { playbookId: best.id, matched: true, score: best.score } : null;
}

function inferTargetPortal(task: string): string | null {
  const lower = task.toLowerCase();
  if (lower.includes("rs.ge") || lower.includes("tax") || lower.includes("vat") || lower.includes("დღგ")) {
    return "rs.ge";
  }
  const urlMatch = task.match(/https?:\/\/[^\s)]+/i);
  if (!urlMatch) return null;
  try {
    return new URL(urlMatch[0]).hostname;
  } catch {
    return null;
  }
}

function buildCompiledTask(input: {
  task: unknown;
  data: unknown;
  safetyMode: SafetyMode;
  explicitPlaybookId: string;
  effectivePlaybookId: string;
  taskMatch: { playbookId: string; score: number } | null;
  mode: AgentMode;
  allowedDomains: string[];
  sessionKey: string;
}) {
  const dataKeys =
    input.data && typeof input.data === "object" && !Array.isArray(input.data)
      ? Object.keys(input.data as Record<string, unknown>).filter((key) => {
          const value = (input.data as Record<string, unknown>)[key];
          return value !== undefined && value !== null && String(value).trim() !== "";
        })
      : [];
  const taskText = typeof input.task === "string" ? input.task.trim() : "";
  return {
    targetPortal: inferTargetPortal(taskText),
    operation: taskText || (input.effectivePlaybookId ? "playbook_run" : "free_form_run"),
    requiredDataKeys: dataKeys,
    safetyMode: input.safetyMode,
    mode: input.mode,
    allowedDomains: input.allowedDomains,
    sessionKey: input.sessionKey,
    candidatePlaybookId: input.effectivePlaybookId || null,
    routing: input.taskMatch
      ? "reviewed_playbook_match"
      : input.explicitPlaybookId
        ? "explicit_playbook"
        : "free_form",
    confidence: input.taskMatch ? input.taskMatch.score : input.effectivePlaybookId ? 1 : 0,
  };
}

// ── GET /agent/context ─────────────────────────────────────────────────────────
// Returns relevant knowledge-base chunks for a given task query.
// Used by the Python agent to enrich its task prompt.

router.get("/context", async (req: Request, res: Response) => {
  try {
    const { task, limit = "12", taskKind } = req.query;

    if (typeof task !== "string" || !task.trim()) {
      throw new HttpError(400, "task query param is required");
    }

    const seedLimit = Math.max(1, Math.min(50, Number(limit) || config.ragTopK));
    const neighborWindow = Math.max(0, config.ragNeighborWindow);
    const maxContextChunks = Math.max(seedLimit, config.ragMaxContextChunks);
    const embedding = await geminiService.embed(formatQueryForEmbedding(task.trim()));
    // R3: optional task-kind filter. When passed (e.g. "vat_monthly"), books
    // whose metadata.tags / topic / title contain that keyword are softly
    // preferred (~40% distance reduction). No-op if the value is empty or
    // there are no tagged books to match.
    const kindFilter = typeof taskKind === "string" ? taskKind.trim() : "";
    const chunks = await searchBookChunksWithNeighbors(
      embedding,
      seedLimit,
      neighborWindow,
      maxContextChunks,
      kindFilter || undefined,
    );

    res.json({
      success: true,
      task,
      taskKind: kindFilter || null,
      chunks,
      context: {
        seedLimit,
        neighborWindow,
        maxContextChunks,
        chunksReturned: chunks.length,
        truncated: chunks.length >= maxContextChunks,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/validate-data ─────────────────────────────────────────────────
// Pre-flight Excel-vs-tax-code validation. Returns a list of issues for fields
// the accounting-knowledge base flags as wrong / unnecessary / requiring a
// license. Empty issues array = data looks fine.
//
// Body: { data: Record<string, string>, taskHint?: string, playbookId?: string }
//
// Same vector store as /agent/context and /chat — the chat brain literally
// reviews the Excel for the user.

const VALIDATE_CACHE = new Map<string, { ts: number; payload: unknown }>();
const VALIDATE_CACHE_TTL_MS = 10 * 60 * 1000;

function normalizeApprovalContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return {
    amount: typeof obj.amount === "number" ? obj.amount : undefined,
    previousPeriodMedian:
      typeof obj.previousPeriodMedian === "number" ? obj.previousPeriodMedian : undefined,
    projectedDeclarationTotal:
      typeof obj.projectedDeclarationTotal === "number"
        ? obj.projectedDeclarationTotal
        : undefined,
    previousDeclarationTotal:
      typeof obj.previousDeclarationTotal === "number"
        ? obj.previousDeclarationTotal
        : undefined,
  };
}

function normalizeApprovalPolicy(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return {
    confidenceThreshold:
      typeof obj.confidenceThreshold === "number" ? obj.confidenceThreshold : undefined,
    unusualAmountMultiplier:
      typeof obj.unusualAmountMultiplier === "number"
        ? obj.unusualAmountMultiplier
        : undefined,
    declarationDeltaThreshold:
      typeof obj.declarationDeltaThreshold === "number"
        ? obj.declarationDeltaThreshold
        : undefined,
    blockOnAgentWarnings:
      typeof obj.blockOnAgentWarnings === "boolean" ? obj.blockOnAgentWarnings : undefined,
    blockOnIrreversibleActions:
      typeof obj.blockOnIrreversibleActions === "boolean"
        ? obj.blockOnIrreversibleActions
        : undefined,
  };
}

router.post("/validate-data", async (req: Request, res: Response) => {
  try {
    const { data, taskHint, playbookId } = req.body ?? {};
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(400, "data must be an object of {field: value}");
    }

    // Cache key — same data + same playbook → same answer for ~10 min.
    const cacheKey = createHash("sha256")
      .update(JSON.stringify({ data, taskHint: taskHint ?? "", playbookId: playbookId ?? "" }))
      .digest("hex");
    const cached = VALIDATE_CACHE.get(cacheKey);
    if (cached && Date.now() - cached.ts < VALIDATE_CACHE_TTL_MS) {
      res.json(cached.payload);
      return;
    }

    // Build the embedding from column-keys + the task hint, similar to
    // /agent/context's pattern. Keys carry the most signal — they include the
    // Georgian field labels for our VAT Excel.
    const keysJoin = Object.keys(data).join(" ");
    const queryText = formatQueryForEmbedding(
      [keysJoin, taskHint || "", "VAT declaration validation Georgian tax code"]
        .filter(Boolean)
        .join(" "),
    );
    const embedding = await geminiService.embed(queryText);
    const chunks = await searchBookChunks(embedding, 12);

    const issues = await geminiService.validateData(
      data as Record<string, string>,
      chunks.map((c) => ({
        content: typeof c.content === "string" ? c.content : "",
        book_title: typeof c.book_title === "string" ? c.book_title : undefined,
      })),
      { taskHint: typeof taskHint === "string" ? taskHint : undefined },
    );

    const hasValidationWarning = issues.some(
      (issue) => issue.field === "validation" && issue.level === "warn",
    );
    const payload = {
      success: true,
      validation_status: hasValidationWarning ? "unknown" : "checked",
      issues,
      checked_fields: Object.keys(data).length,
      knowledge_chunks_used: chunks.length,
    };
    VALIDATE_CACHE.set(cacheKey, { ts: Date.now(), payload });
    res.json(payload);
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/cache ─────────────────────────────────────────────────────────
// Receives a successful run's action history from the Python agent and stores
// it as a cached replay sequence. Phase 2 will read this cache and execute it
// via Playwright directly (no LLM) on subsequent runs of the same playbook.

router.post("/financial-plan", async (req: Request, res: Response) => {
  try {
    const {
      operation,
      countryCode,
      taskHint,
      alreadyDone,
      approvalContext,
      approvalPolicy,
      useKnowledge = true,
      persist = true,
    } = req.body ?? {};
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
      throw new HttpError(400, "operation must be an object");
    }

    let ragChunks: Array<{ content: string; bookTitle?: string; chunkIndex?: number }> = [];
    if (useKnowledge !== false) {
      const queryText = formatQueryForEmbedding(
        [
          JSON.stringify(operation).slice(0, 4000),
          typeof taskHint === "string" ? taskHint : "",
          "Georgian VAT accounting tax treatment RS.ge action planning",
        ]
          .filter(Boolean)
          .join(" "),
      );
      const embedding = await geminiService.embed(queryText);
      const chunks = await searchBookChunks(embedding, 12);
      ragChunks = chunks.map((chunk) => ({
        content: typeof chunk.content === "string" ? chunk.content : "",
        bookTitle: typeof chunk.book_title === "string" ? chunk.book_title : undefined,
        chunkIndex: typeof chunk.chunk_index === "number" ? chunk.chunk_index : undefined,
      }));
    }

    // Anomaly memory: if the caller didn't supply previousPeriodMedian, look
    // it up from past agent_runs for the same (company, category, currency).
    // We need to know category, so we run the classifier in two passes — but
    // since analyzeFinancialOperation runs them sequentially internally,
    // we instead pre-fill nothing here and rely on a second-pass override.
    const normalizedContext = normalizeApprovalContext(approvalContext);
    const operationAmount =
      typeof (operation as Record<string, unknown>).amount === "number"
        ? ((operation as Record<string, unknown>).amount as number)
        : normalizedContext?.amount;
    const operationCurrency =
      typeof (operation as Record<string, unknown>).currency === "string"
        ? ((operation as Record<string, unknown>).currency as string)
        : null;

    const result = await analyzeFinancialOperation(
      {
        operation: operation as Record<string, unknown>,
        countryCode: typeof countryCode === "string" ? countryCode : "GE",
        ragChunks,
        alreadyDone,
        approvalContext: normalizedContext,
        approvalPolicy: normalizeApprovalPolicy(approvalPolicy),
      },
      { gemini: geminiService },
    );

    // If the caller didn't supply previousPeriodMedian AND we now know the
    // category + currency, re-run only the approval gate with the looked-up
    // median. This costs one cheap SQL query and zero LLM calls.
    let augmentedResult = result;
    const needsMedianLookup =
      (normalizedContext?.previousPeriodMedian === undefined) &&
      typeof operationAmount === "number" &&
      typeof operationCurrency === "string" &&
      operationCurrency.length > 0;
    if (needsMedianLookup) {
      try {
        const median = await medianAmountByCategory({
          companyId: req.companyId,
          category: result.classification.output.category,
          currency: operationCurrency as string,
        });
        if (typeof median === "number") {
          const reEvaluated = evaluateApproval(
            {
              confidence: result.summary.confidence,
              warnings: [
                ...result.classification.warnings,
                ...result.taxReasoning.warnings,
                ...result.actionPlan.warnings,
              ],
            },
            {
              ...(normalizedContext ?? {}),
              amount: operationAmount,
              previousPeriodMedian: median,
              taxRisk: result.taxReasoning.output.tax_risk,
              hasIrreversibleActions: result.summary.hasIrreversibleActions,
            },
            normalizeApprovalPolicy(approvalPolicy),
          );
          augmentedResult = {
            ...result,
            approval: reEvaluated,
            summary: {
              ...result.summary,
              approved: reEvaluated.approved,
            },
          };
        }
      } catch (err) {
        // Median lookup is best-effort; never fail the analyse call because
        // of it. The original approval (without median) stands.
        console.warn(
          "[financial-plan] median lookup failed, keeping original approval:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Persist for audit + approval queue. Best-effort: a write failure
    // returns the analysed result without a row id rather than 500.
    let runId: string | null = null;
    if (persist !== false) {
      try {
        const row = await insertAgentRun({
          companyId: req.companyId,
          operation,
          amount:
            typeof operationAmount === "number" && Number.isFinite(operationAmount)
              ? operationAmount
              : null,
          currency: operationCurrency,
          result: augmentedResult,
        });
        runId = row.id;
      } catch (err) {
        console.warn(
          "[financial-plan] persistence failed; returning result without runId:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    res.json({
      success: true,
      knowledge_chunks_used: ragChunks.length,
      run_id: runId,
      result: augmentedResult,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ── Approval queue routes ──────────────────────────────────────────────────
//
// The UI of the Approval Layer (Agent #4 in the plan) lives on these
// endpoints. Each route is per-company via tenantMiddleware.

router.get("/financial-plans", async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const category =
      typeof req.query.category === "string" ? req.query.category : undefined;
    const taxRisk =
      typeof req.query.taxRisk === "string" ? req.query.taxRisk : undefined;
    const limit = Number(req.query.limit ?? 50);
    const offset = Number(req.query.offset ?? 0);

    const validStatuses: AgentRunStatus[] = [
      "pending_review",
      "approved",
      "executed",
      "rejected",
      "auto_approved",
    ];
    const statusFilter =
      status && (validStatuses as string[]).includes(status)
        ? (status as AgentRunStatus)
        : undefined;

    const rows = await listAgentRuns({
      companyId: req.companyId,
      status: statusFilter,
      category,
      taxRisk,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    res.json({ success: true, runs: rows });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/financial-plans/:id", async (req: Request, res: Response) => {
  try {
    const row = await getAgentRunById(req.companyId, req.params.id);
    if (!row) throw new HttpError(404, `Agent run ${req.params.id} not found`);
    res.json({ success: true, run: row });
  } catch (error) {
    sendError(res, error);
  }
});

// Structural subset of rs-action-planner.PlannedAction — kept local to the
// route so we don't import the planner just to read JSONB.
interface PlannedActionPayload {
  type: string;
  playbook_key: string;
  country_code: string;
  mcp_args?: Record<string, unknown>;
  required_inputs?: string[];
}

/**
 * Dispatch an approved Financial Agent Stack run as a bulk playbook run.
 *
 * Each action in the plan with a non-"none" playbook_key becomes one row.
 * The row's data is built from the action's mcp_args (already grounded in
 * the operation by the planner), plus the caller-provided `inputs` map
 * which fills the action's `required_inputs`. We refuse to dispatch when
 * a required input is missing — the alternative (silently dropping it)
 * would let the browser agent crash mid-flow on rs.ge.
 *
 * Pre-conditions checked here, not in the worker, so the caller gets a
 * meaningful 400 instead of an opaque worker failure 20 minutes later:
 *   - run is in approved/auto_approved state (rejected/pending refuse)
 *   - every action's playbook_key resolves to a real reviewed playbook
 *   - every action's required_inputs are present
 */
router.post("/financial-plans/:id/execute", async (req: Request, res: Response) => {
  try {
    const run = await getAgentRunById(req.companyId, req.params.id);
    if (!run) throw new HttpError(404, `Agent run ${req.params.id} not found`);

    if (run.status !== "approved" && run.status !== "auto_approved") {
      throw new HttpError(
        409,
        `Run is ${run.status}; only approved/auto_approved runs can be executed`,
      );
    }

    const inputs =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? ((req.body as Record<string, unknown>).inputs as Record<string, unknown>) ?? {}
        : {};

    const actionPlan = run.action_plan as {
      output: { actions: PlannedActionPayload[] };
    } | null;
    const actions = actionPlan?.output?.actions ?? [];

    type DispatchSeed = {
      action: PlannedActionPayload;
      playbook: PlaybookRow;
    };
    const seeds: DispatchSeed[] = [];
    const missingPlaybooks: string[] = [];
    const missingInputs: string[] = [];

    for (const action of actions) {
      // Skip pure no-ops and pure read-only MCP actions (no playbook).
      if (
        action.type === "skip_no_action" ||
        action.playbook_key === "none" ||
        !action.playbook_key
      ) {
        continue;
      }
      const playbook = await findPlaybookByKey(
        req.companyId,
        action.country_code || "GE",
        action.playbook_key,
      );
      if (!playbook) {
        missingPlaybooks.push(action.playbook_key);
        continue;
      }
      if (playbook.review_status !== "reviewed" || playbook.steps.length === 0) {
        throw new HttpError(
          400,
          `Playbook "${action.playbook_key}" exists but is not reviewed/empty — review it first`,
        );
      }
      for (const required of action.required_inputs ?? []) {
        if (!(required in inputs) && !(required in (action.mcp_args ?? {}))) {
          missingInputs.push(`${action.playbook_key}: ${required}`);
        }
      }
      seeds.push({ action, playbook });
    }

    if (missingPlaybooks.length > 0) {
      throw new HttpError(
        400,
        `No registered playbook for key(s): ${missingPlaybooks.join(", ")}. ` +
          `Record + review each playbook and tag it with this key under AI Playbooks first.`,
      );
    }
    if (missingInputs.length > 0) {
      throw new HttpError(
        400,
        `Missing required inputs: ${missingInputs.join("; ")}.`,
      );
    }
    if (seeds.length === 0) {
      throw new HttpError(
        400,
        `Nothing to execute — this plan has no playbook-backed actions.`,
      );
    }

    const rowSeeds = seeds.map((seed, idx) => ({
      row_index: idx,
      playbook_id: seed.playbook.id,
      data: {
        merged: { ...(seed.action.mcp_args ?? {}), ...inputs },
        raw: {
          agent_run_id: run.id,
          action_type: seed.action.type,
          playbook_key: seed.action.playbook_key,
        },
      },
    }));

    const runConfig = {
      mode: "bulk" as AgentMode,
      sharedData: {},
      mapping: {},
      playbookColumn: null,
      playbookMap: {},
      defaultPlaybookId: null,
      safetyMode: "halt-on-dangerous" as const,
      allowedDomains: normalizeAllowedDomains(undefined),
      sessionKey: "main_user",
      maxSteps: null,
      record: true,
      task: `Execute Financial Agent run ${run.id}`,
      stopOnFailure: true,
      sourceAgentRunId: run.id,
    };

    const bulkRun = await createBulkRun({
      companyId: req.companyId,
      config: runConfig,
      rows: rowSeeds,
    });
    const procs = spawnBulkWorker(bulkRun.id, req.companyId);
    await markRunStarted(bulkRun.id, procs[0]?.pid ?? 0);

    // Move the agent run to "executed" so the queue UI stops surfacing it.
    await decideAgentRun({
      companyId: req.companyId,
      id: run.id,
      decision: "executed",
      reviewedBy: typeof req.userId === "string" ? req.userId : undefined,
      reviewNote: `Dispatched bulk run ${bulkRun.id}`,
    });

    res.status(201).json({
      success: true,
      bulk_run_id: bulkRun.id,
      action_count: rowSeeds.length,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/financial-plans/:id/decision", async (req: Request, res: Response) => {
  try {
    const { decision, note } = req.body ?? {};
    const validDecisions = ["approved", "rejected", "executed"] as const;
    if (!(validDecisions as readonly string[]).includes(decision)) {
      throw new HttpError(400, `decision must be one of: ${validDecisions.join(", ")}`);
    }

    const row = await decideAgentRun({
      companyId: req.companyId,
      id: req.params.id,
      decision: decision as (typeof validDecisions)[number],
      reviewedBy: typeof req.userId === "string" ? req.userId : undefined,
      reviewNote: typeof note === "string" ? note : undefined,
    });
    if (!row) throw new HttpError(404, `Agent run ${req.params.id} not found`);
    res.json({ success: true, run: row });
  } catch (error) {
    sendError(res, error);
  }
});

// Dispatch a single chat tool from the UI (used by /dashboard/alerts'
// "Suggested actions" buttons). Reuses the same registry the chat
// brain calls — one source of truth for what tools exist + what they
// do. Slice B tools are all read-only; Slice C will add write tools
// that go through the Approval Gate inside the handler.
router.post("/chat-tools/:name", async (req: Request, res: Response) => {
  try {
    const { dispatchTool } = await import("../services/chat-tools");
    const args =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? ((req.body as Record<string, unknown>).args as Record<string, unknown>) ??
          {}
        : {};
    const result = await dispatchTool(req.params.name, args, {
      companyId: req.companyId,
      userId: req.userId,
    });
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/cache", async (req: Request, res: Response) => {
  try {
    const { playbookId, actions, safetyMode, completionState, postconditions } = req.body ?? {};
    if (typeof playbookId !== "string" || !playbookId.trim()) {
      throw new HttpError(400, "playbookId is required");
    }
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new HttpError(400, "actions[] is required and must be non-empty");
    }

    const playbook = await findPlaybookById(req.companyId, playbookId);
    if (!playbook) throw new HttpError(404, `Playbook ${playbookId} not found`);
    assertReviewedPlaybook(playbook);

    const resolvedSafetyMode: SafetyMode = isSafetyMode(safetyMode) ? safetyMode : "halt-on-dangerous";
    const resolvedCompletionState: ExecutionCompletionState = isCompletionState(completionState)
      ? completionState
      : defaultCompletionState(resolvedSafetyMode);

    const playbookVersion = computePlaybookVersion(playbook.steps ?? []);
    const cache = await upsertCache({
      playbookId,
      playbookVersion,
      actions: actions as CachedAction[],
      safetyMode: resolvedSafetyMode,
      completionState: resolvedCompletionState,
      postconditions:
        postconditions && typeof postconditions === "object" && !Array.isArray(postconditions)
          ? postconditions as Record<string, unknown>
          : {},
    });

    res.json({
      success: true,
      cache: {
        id: cache.id,
        playbookId: cache.playbook_id,
        playbookVersion: cache.playbook_version,
        actionCount: actions.length,
        recordedCount: cache.recorded_count,
        safetyMode: cache.safety_mode,
        completionState: cache.completion_state,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ── GET /agent/cache?playbookId=...&withActions=1 ─────────────────────────────
// Returns the latest cache for a playbook (or null if none exists yet).
// Pass ?withActions=1 to include the raw `actions` array (used by the Python
// replay path); omit for a lightweight metadata-only response (used by UI).

router.get("/cache", async (req: Request, res: Response) => {
  try {
    const { playbookId, withActions } = req.query;
    if (typeof playbookId !== "string" || !playbookId.trim()) {
      throw new HttpError(400, "playbookId query param is required");
    }
    const includeActions = withActions === "1" || withActions === "true";

    const playbook = await findPlaybookById(req.companyId, playbookId);
    if (!playbook) throw new HttpError(404, `Playbook ${playbookId} not found`);

    const playbookVersion = computePlaybookVersion(playbook.steps ?? []);
    const cache = await findCacheByPlaybook(playbookId, playbookVersion);
    const allCaches = await listCachesForPlaybook(playbookId);

    res.json({
      success: true,
      playbookVersion,
      currentCache: cache
        ? {
            id: cache.id,
            actionCount: Array.isArray(cache.actions) ? cache.actions.length : 0,
            successCount: cache.success_count,
            recordedCount: cache.recorded_count,
            safetyMode: cache.safety_mode,
            completionState: cache.completion_state,
            postconditions: cache.postconditions,
            lastUsedAt: cache.last_used_at,
            updatedAt: cache.updated_at,
            ...(includeActions ? { actions: cache.actions } : {}),
          }
        : null,
      otherVersions: allCaches
        .filter((c) => c.playbook_version !== playbookVersion)
        .map((c) => ({
          id: c.id,
          version: c.playbook_version,
          actionCount: Array.isArray(c.actions) ? c.actions.length : 0,
          successCount: c.success_count,
          safetyMode: c.safety_mode,
          completionState: c.completion_state,
          updatedAt: c.updated_at,
        })),
    });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/cache/hit ─────────────────────────────────────────────────────
// Called by the Python replay path after a successful cache replay. Bumps the
// success_count and last_used_at for the cache row.

// ── GET /agent/cache/all ──────────────────────────────────────────────────────
// Returns the latest cache row per playbook (keyed by playbook_id). Used by
// the Playbooks list page to render a "💾 N replays" badge on each card.

router.get("/cache/all", async (req: Request, res: Response) => {
  try {
    const summaries = await listLatestCachesByPlaybook(req.companyId);
    const byPlaybookId: Record<string, {
      actionCount: number;
      successCount: number;
      recordedCount: number;
      updatedAt: string;
      safetyMode: SafetyMode;
      completionState: ExecutionCompletionState;
    }> = {};
    for (const s of summaries) {
      byPlaybookId[s.playbook_id] = {
        actionCount: s.action_count,
        successCount: s.success_count,
        recordedCount: s.recorded_count,
        updatedAt: s.updated_at,
        safetyMode: s.safety_mode,
        completionState: s.completion_state,
      };
    }
    res.json({ success: true, caches: byPlaybookId });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/cache/hit", async (req: Request, res: Response) => {
  try {
    const { cacheId, completionState } = req.body ?? {};
    if (typeof cacheId !== "string" || !cacheId.trim()) {
      throw new HttpError(400, "cacheId is required");
    }
    const { recordCacheHit } = await import("../repositories/playbookCache");
    await recordCacheHit(cacheId, isCompletionState(completionState) ? completionState : undefined);
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/runs/:runId/resume ────────────────────────────────────────────
// When the agent has emitted {type:"paused"} (e.g. blocked on auth/captcha),
// the UI calls this to tell Python to call agent.resume(). Implemented as a
// stdin message — the Python process reads control commands line-by-line.

router.post("/runs/:runId/resume", (req: Request, res: Response) => {
  const { runId } = req.params;
  const proc = runRegistry.get(runId);
  if (!proc) {
    res.status(404).json({ success: false, message: `No active run with id ${runId}` });
    return;
  }
  if (!proc.stdin || proc.stdin.destroyed) {
    res.status(409).json({ success: false, message: "Run process stdin is not writable" });
    return;
  }
  try {
    proc.stdin.write(JSON.stringify({ action: "resume" }) + "\n");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── POST /agent/runs/:runId/cancel ────────────────────────────────────────────
// Cancel a single run mid-flight. Writes {"action":"cancel"} to the Python
// agent's stdin so it can exit cleanly (in particular, abort during the
// plan-preview window before launching the browser). If stdin is closed,
// fall back to SIGTERM.
router.post("/runs/:runId/cancel", (req: Request, res: Response) => {
  const { runId } = req.params;
  const proc = runRegistry.get(runId);
  if (!proc) {
    res.status(404).json({ success: false, message: `No active run with id ${runId}` });
    return;
  }
  try {
    if (proc.stdin && !proc.stdin.destroyed) {
      proc.stdin.write(JSON.stringify({ action: "cancel" }) + "\n");
    } else if (!proc.killed) {
      proc.kill("SIGTERM");
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// ── POST /agent/runs/:runId/skip-preview ──────────────────────────────────────
// User clicked "start now" on the plan-preview banner — unblock the wait early.
router.post("/runs/:runId/skip-preview", (req: Request, res: Response) => {
  const { runId } = req.params;
  const proc = runRegistry.get(runId);
  if (!proc) {
    res.status(404).json({ success: false, message: `No active run with id ${runId}` });
    return;
  }
  if (!proc.stdin || proc.stdin.destroyed) {
    res.status(409).json({ success: false, message: "Run process stdin is not writable" });
    return;
  }
  try {
    proc.stdin.write(JSON.stringify({ action: "skip_preview" }) + "\n");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// In-memory registry of active /agent/run processes, keyed by runId.
// Used by /agent/runs/:runId/resume to write a control command to stdin.
const runRegistry = new Map<string, ChildProcess>();

// ── Phase Q1: GET /agent/site-memory/:domain ──────────────────────────────────
// Returns the distilled SiteKnowledge for a domain (pages, transitions,
// dialogs, field-map). Consumed by the Python agent in free-form mode when
// no single playbook scores high enough on its own.

router.get("/site-memory/:domain", async (req: Request, res: Response) => {
  try {
    const domain = normalizeDomain(req.params.domain);
    if (!domain) {
      throw new HttpError(400, "domain required");
    }
    const row = await getSiteMemory(req.companyId, domain);
    if (!row) {
      res.json({ success: true, domain, knowledge: null, source_playbook_count: 0 });
      return;
    }
    res.json({
      success: true,
      domain: row.domain,
      knowledge: row.knowledge_json,
      source_playbook_count: row.source_playbook_count,
      source_playbook_ids: row.source_playbook_ids,
      updated_at: row.updated_at,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/site-memory", async (req: Request, res: Response) => {
  try {
    const rows = await listSiteMemoryDomains(req.companyId);
    res.json({ success: true, domains: rows });
  } catch (error) {
    sendError(res, error);
  }
});

// Manual bootstrap: rebuild site_memory for a given domain from the current
// set of reviewed playbooks. Used when migrations land after playbooks were
// already reviewed (so the auto-distill PATCH-time hook never fired).
router.post("/site-memory/:domain/rebuild", async (req: Request, res: Response) => {
  try {
    const domain = normalizeDomain(req.params.domain);
    if (!domain) throw new HttpError(400, "domain required");
    const result = await rebuildSiteMemoryFor(req.companyId, domain);
    res.json({ success: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

// ── Phase Q2: failure pattern library ─────────────────────────────────────────
// POST /agent/failure-patterns — agent reports a K1/M1/K4/postcondition fail
// GET  /agent/failure-patterns?domain=... — Worker pulls top patterns to inject

router.post("/failure-patterns", async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    if (!isFailureType(body.failure_type)) {
      throw new HttpError(400, `failure_type must be one of k1_hallucination/m1_zero_field/m1_not_confirmation/k4_url/postcondition/manual`);
    }
    if (typeof body.symptom !== "string" || !body.symptom.trim()) {
      throw new HttpError(400, "symptom required");
    }
    const row = await recordFailurePattern({
      companyId: req.companyId,
      domain: typeof body.domain === "string" ? body.domain : "",
      url_pattern: typeof body.url_pattern === "string" ? body.url_pattern : null,
      field_label: typeof body.field_label === "string" ? body.field_label : null,
      failure_type: body.failure_type,
      symptom: body.symptom,
      workaround: typeof body.workaround === "string" ? body.workaround : null,
    });
    res.json({ success: true, pattern: row });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/failure-patterns", async (req: Request, res: Response) => {
  try {
    const domain = normalizeDomain(typeof req.query.domain === "string" ? req.query.domain : "");
    if (!domain) {
      throw new HttpError(400, "domain query param required");
    }
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 100) : 30;
    const rows = await listFailurePatterns(req.companyId, domain, limit);
    res.json({ success: true, domain, patterns: rows });
  } catch (error) {
    sendError(res, error);
  }
});

// ── GET /agent/analytics ──────────────────────────────────────────────────────
// Returns per-playbook stats (runs, success rate, cache hit rate, cost saved)
// plus a global summary line. Used by the /analytics dashboard page.

router.get("/analytics", async (req: Request, res: Response) => {
  try {
    const days = req.query.days ? Number(req.query.days) : undefined;
    const trendDays = days && days <= 90 ? Math.min(days, 30) : 14;
    const [playbooks, summary, trend, recentFailures] = await Promise.all([
      getPlaybookAnalytics(req.companyId, days),
      getAnalyticsSummary(req.companyId, days),
      getDailyTrend(req.companyId, trendDays),
      getRecentFailures(req.companyId, 20),
    ]);
    res.json({ success: true, summary, playbooks, trend, recentFailures });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/run ────────────────────────────────────────────────────────────
// Spawns the Python agent and streams its stdout back as Server-Sent Events.
// Each SSE event is a JSON-encoded line from agent/main.py.

router.post("/run", async (req: Request, res: Response) => {
  const {
    task,
    data = {},
    maxSteps,
    record = true,
    playbookId,
    safetyMode,
    allowedDomains,
    sessionKey,
    mode,
  } = req.body ?? {};

  if (!playbookId && (typeof task !== "string" || !task.trim())) {
    res.status(400).json({ success: false, message: "task or playbookId is required" });
    return;
  }

  const requestedSafetyMode: SafetyMode = isSafetyMode(safetyMode) ? safetyMode : "halt-on-dangerous";
  const requestedAllowedDomains = normalizeAllowedDomains(allowedDomains);
  const requestedSessionKey = normalizeSessionKey(sessionKey);
  let effectivePlaybookId = typeof playbookId === "string" && playbookId.trim() ? playbookId.trim() : "";
  const explicitPlaybookId = effectivePlaybookId;
  let taskMatch: { playbookId: string; score: number } | null = null;

  try {
    const candidate = await compileTaskCandidate({
      companyId: req.companyId,
      task: typeof task === "string" ? task : "",
      playbookId: effectivePlaybookId || undefined,
    });
    if (candidate?.playbookId) {
      const selected = await findPlaybookById(req.companyId, candidate.playbookId);
      if (!selected) throw new HttpError(404, `Playbook ${candidate.playbookId} not found`);
      assertReviewedPlaybook(selected);
      effectivePlaybookId = selected.id;
      if (candidate.matched) taskMatch = { playbookId: selected.id, score: candidate.score };
    }
  } catch (error) {
    sendError(res, error);
    return;
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable nginx buffering if behind proxy
  res.flushHeaders();

  // Generate a runId so the UI can later POST /agent/runs/:runId/resume.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const requestedMode = normalizeAgentMode(mode, Boolean(effectivePlaybookId));
  const compiledTask = buildCompiledTask({
    task,
    data,
    safetyMode: requestedSafetyMode,
    explicitPlaybookId,
    effectivePlaybookId,
    taskMatch,
    mode: requestedMode,
    allowedDomains: requestedAllowedDomains,
    sessionKey: requestedSessionKey,
  });

  const args = [AGENT_SCRIPT];
  if (effectivePlaybookId) {
    args.push("--playbook", String(effectivePlaybookId));
    if (task?.trim()) args.push("--task", task.trim());
  } else {
    args.push("--task", task.trim());
  }
  args.push("--data", JSON.stringify(data));
  if (maxSteps) args.push("--max-steps", String(maxSteps));
  if (record === false) args.push("--no-record");
  args.push("--safety-mode", requestedSafetyMode);
  args.push("--allowed-domains", requestedAllowedDomains.join(","));
  args.push("--session-key", requestedSessionKey);
  args.push("--mode", requestedMode);

  const proc = spawn(PYTHON_BIN, args, {
    env: {
      ...process.env,
      // Explicitly forward API keys so the Python agent always has them,
      // even if it can't locate a .env file on its own.
      ...(config.geminiApiKey ? { GEMINI_API_KEY: config.geminiApiKey } : {}),
      ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
      BACKEND_URL: `http://localhost:${process.env.PORT ?? 3001}`,
      RUN_ID: runId,
      // Tenant isolation for the Chromium profile dir + saved auth state.
      // Without this two tenants on the same host would share rs.ge cookies.
      AGENT_COMPANY_ID: req.companyId,
      // Worker auth — Python sends these on every callback so it can pass
      // the same tenantMiddleware that gates user requests.
      AI_INTERNAL_SECRET: process.env.AI_INTERNAL_SECRET ?? "",
      BROWSER_USE_CONFIG_DIR,
    },
    cwd: path.dirname(AGENT_SCRIPT),
  });

  runRegistry.set(runId, proc);

  // Tell the UI which runId to use for resume calls.
  res.write(`data: ${JSON.stringify({ type: "run-started", runId })}\n\n`);
  res.write(`data: ${JSON.stringify({
    type: "task_compiled",
    message: taskMatch
      ? "Matched reviewed playbook for this prompt."
      : effectivePlaybookId
        ? "Using explicit reviewed playbook."
        : "No reviewed playbook matched confidently; using free-form mode.",
    playbookId: effectivePlaybookId || null,
    score: taskMatch?.score ?? (effectivePlaybookId ? 1 : 0),
    compiledTask,
  })}\n\n`);

  function sendEvent(data: unknown) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Buffer for incomplete lines (stdout may arrive in chunks)
  let stdoutBuffer = "";
  let stderrBuffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? ""; // keep incomplete last line

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        sendEvent(parsed);
      } catch {
        // Non-JSON line — wrap it as a plain log
        sendEvent({ type: "log", message: trimmed });
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderrBuffer += chunk.toString();
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        sendEvent({ type: "stderr", message: trimmed });
      }
    }
  });

  proc.on("error", (err) => {
    console.error("Agent spawn error:", err);
    sendEvent({ type: "error", message: `Failed to start agent: ${err.message}` });
    res.end();
  });

  proc.on("close", (code, signal) => {
    console.log(`Agent process closed. Code: ${code}, Signal: ${signal}`);
    runRegistry.delete(runId);
    // Flush any remaining buffered output
    if (stdoutBuffer.trim()) {
      sendEvent({ type: "log", message: stdoutBuffer.trim() });
    }
    sendEvent({ type: "close", exitCode: code, success: code === 0 });
    res.end();
  });

  req.on("aborted", () => {
    console.log("Client request ABORTED. Killing agent...");
    runRegistry.delete(runId);
    if (!proc.killed) proc.kill("SIGTERM");
  });

  // If the client disconnects, kill the agent process
  // req.on("close", () => {
  //   console.log("Client request CLOSED. Killing agent if still running...");
  //   if (!proc.killed) {
  //     proc.kill("SIGTERM");
  //   }
  // });
});

// ── POST /agent/parse-excel ───────────────────────────────────────────────────
// Accepts an .xlsx upload, returns the headers + parsed rows.
// The client uses this to preview and map columns to playbook variables.

router.post("/parse-excel", excelUpload.single("file"), async (req: Request, res: Response) => {
  let tempPath: string | undefined;
  try {
    if (!req.file) throw new HttpError(400, "file is required (field name: 'file')");
    tempPath = req.file.path;
    const parsed = await parseSpreadsheet(tempPath);
    if (!parsed.headers.length) {
      throw new HttpError(400, "Spreadsheet has no header row or is empty");
    }
    res.json({ success: true, ...parsed });
  } catch (error) {
    sendError(res, error);
  } finally {
    if (tempPath) await fs.unlink(tempPath).catch(() => { });
  }
});

// ── Bulk run worker registry ──────────────────────────────────────────────────
// In-memory map of runId -> ChildProcess so that /cancel can SIGTERM the worker.
// Survives only as long as this Node process; that's fine since on backend
// restart the stalled scanner will catch any orphaned runs via heartbeat timeout.

// One bulk run can be served by N concurrent Python workers, each picking
// rows from the same DB queue (FOR UPDATE SKIP LOCKED makes this safe).
// Default: 1 worker (current behaviour). Override with BULK_WORKER_CONCURRENCY.
const workerRegistry = new Map<string, ChildProcess[]>();

const DEFAULT_BULK_CONCURRENCY = Math.max(
  1,
  Math.min(8, Number(process.env.BULK_WORKER_CONCURRENCY ?? 1)),
);

/**
 * Dispatch N worker processes for a bulk run.
 *
 * Two modes, picked at runtime based on `AGENT_RUNTIME_URL`:
 *
 *   1. **HTTP dispatch** (production / Railway): POST to the agent-runtime
 *      service which spawns the Python subprocesses inside its own
 *      Chromium-equipped container. We return [] because there are no
 *      local processes to track — agent-backend already tracks
 *      lifecycle via bulk_run_rows + recordHeartbeat.
 *   2. **Local spawn** (dev / no AGENT_RUNTIME_URL): the legacy path that
 *      spawns `python main.py --bulk-run-id X` in the same process tree.
 *      Used when AGENT_RUNTIME_URL is unset (typical dev box with Python
 *      installed alongside agent-backend).
 */
export function spawnBulkWorker(
  runId: string,
  companyId: string,
  concurrency?: number,
): ChildProcess[] {
  const n = Math.max(1, Math.min(8, concurrency ?? DEFAULT_BULK_CONCURRENCY));
  const runtimeUrl = process.env.AGENT_RUNTIME_URL?.replace(/\/$/, "");

  if (runtimeUrl) {
    // Fire-and-forget HTTP dispatch. The agent-runtime returns 202
    // immediately after spawning local subprocesses — we don't await
    // a per-row result here (those flow back via the bulk-row HTTP
    // callbacks the workers make to /agent/bulk-runs/:id/rows/:i/result).
    const body = JSON.stringify({
      bulk_run_id: runId,
      company_id: companyId,
      concurrency: n,
    });
    fetch(`${runtimeUrl}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.AI_INTERNAL_SECRET ?? "",
      },
      body,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          console.error(
            `[bulk ${runId.slice(0, 8)}] agent-runtime ${res.status}: ${text.slice(0, 200)}`,
          );
          await markRunFinished(
            runId,
            "failed",
            `agent-runtime dispatch failed: HTTP ${res.status}`,
          ).catch(() => undefined);
        } else {
          console.log(
            `[bulk ${runId.slice(0, 8)}] dispatched ${n} worker(s) to agent-runtime`,
          );
        }
      })
      .catch(async (err) => {
        console.error(
          `[bulk ${runId.slice(0, 8)}] agent-runtime dispatch error:`,
          err instanceof Error ? err.message : err,
        );
        await markRunFinished(
          runId,
          "failed",
          `agent-runtime unreachable: ${err instanceof Error ? err.message : err}`,
        ).catch(() => undefined);
      });
    return [];
  }

  // Local spawn (dev path).
  // Headless is forced when more than 1 worker — 4 visible Chromiums would
  // overwhelm the screen and starve focus from each other.
  const headless = n > 1 ? "true" : (process.env.AGENT_HEADLESS ?? "false");

  const procs: ChildProcess[] = [];
  for (let i = 0; i < n; i++) {
    const args = [AGENT_SCRIPT, "--bulk-run-id", runId];
    const proc = spawn(PYTHON_BIN, args, {
      env: {
        ...process.env,
        ...(config.geminiApiKey ? { GEMINI_API_KEY: config.geminiApiKey } : {}),
        ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
        BACKEND_URL: `http://localhost:${process.env.PORT ?? 3001}`,
        AGENT_HEADLESS: headless,
        // Tenant isolation for the Chromium profile dir + saved auth state.
        AGENT_COMPANY_ID: companyId,
        // Worker auth — Python sends these on every callback to satisfy
        // tenantMiddleware on the Node side.
        AI_INTERNAL_SECRET: process.env.AI_INTERNAL_SECRET ?? "",
        BULK_WORKER_INDEX: String(i),
        BROWSER_USE_CONFIG_DIR,
      },
      cwd: path.dirname(AGENT_SCRIPT),
      detached: false,
    });

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[bulk ${runId.slice(0, 8)} w${i}]`, text);
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[bulk ${runId.slice(0, 8)} w${i} stderr]`, text);
    });
    proc.on("error", (err) => {
      console.error(`[bulk ${runId} w${i}] spawn error:`, err);
      // If THIS is the only worker still running for the run, mark it failed.
      const remaining = (workerRegistry.get(runId) ?? []).filter(
        (p) => p !== proc && !p.killed,
      );
      if (remaining.length === 0) {
        void markRunFinished(runId, "failed", `Worker spawn failed: ${err.message}`);
        workerRegistry.delete(runId);
      } else {
        workerRegistry.set(runId, remaining);
      }
    });
    proc.on("close", (code) => {
      const remaining = (workerRegistry.get(runId) ?? []).filter((p) => p !== proc);
      if (remaining.length > 0) {
        workerRegistry.set(runId, remaining);
      } else {
        workerRegistry.delete(runId);
      }
      console.log(`[bulk ${runId.slice(0, 8)} w${i}] worker exited code=${code}`);
    });

    procs.push(proc);
  }

  workerRegistry.set(runId, procs);
  console.log(`[bulk ${runId.slice(0, 8)}] spawned ${n} concurrent worker(s)${n > 1 ? " (headless)" : ""}`);
  return procs;
}

// ── POST /agent/bulk-run ──────────────────────────────────────────────────────
// Creates a bulk_run + bulk_run_rows in DB and spawns ONE Python worker.
// Returns { runId } so the client can navigate to /runs/:id for live progress.
//
// Body: {
//   playbookId?: string,
//   playbookColumn?: string,
//   playbookMap?: Record<string, string>,  // excelValue -> playbookId
//   rows: Record<string, string>[],
//   sharedData?: Record<string, string>,
//   mapping?: Record<string, string>,      // playbookVar -> excelHeader
//   safetyMode?: "auto" | "halt-on-dangerous" | "dry-run",
//   maxSteps?: number,
//   record?: boolean,
//   task?: string,
//   stopOnFailure?: boolean,
// }

router.post("/bulk-run", async (req: Request, res: Response) => {
  try {
    const {
      playbookId,
      playbookColumn,
      playbookMap = {},
      rows,
      sharedData = {},
      mapping = {},
      safetyMode,
      maxSteps,
      record = true,
      task,
      stopOnFailure = false,
      allowedDomains,
      sessionKey,
    } = req.body ?? {};

    const hasDefaultPlaybook = typeof playbookId === "string" && playbookId.length > 0;
    const hasColumnMode = typeof playbookColumn === "string" && playbookColumn.length > 0;
    const hasTask = typeof task === "string" && task.trim().length > 0;

    if (!hasDefaultPlaybook && !hasColumnMode && !hasTask) {
      throw new HttpError(400, "playbookId, playbookColumn, or task is required");
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new HttpError(400, "rows must be a non-empty array");
    }

    // Validate referenced playbook IDs upfront so we fail fast.
    const referencedIds = new Set<string>();
    if (hasDefaultPlaybook) referencedIds.add(playbookId);
    if (hasColumnMode) {
      for (const v of Object.values(playbookMap)) {
        if (typeof v === "string" && v) referencedIds.add(v);
      }
    }
    for (const id of referencedIds) {
      const found = await findPlaybookById(req.companyId, id);
      if (!found) {
        throw new HttpError(400, `Unknown playbook ID: ${id}`);
      }
      assertReviewedPlaybook(found);
    }

    // Build seed rows for the DB: resolve per-row playbook and pre-merge data.
    const seeds = rows.map((row: Record<string, string>, rowIndex: number) => {
      let rowPlaybookId: string | null = null;
      if (hasColumnMode) {
        const rawValue = row[playbookColumn];
        const lookupKey = typeof rawValue === "string" ? rawValue.trim() : "";
        const mapped = lookupKey ? playbookMap[lookupKey] : undefined;
        rowPlaybookId = mapped || (hasDefaultPlaybook ? playbookId : null);
      } else {
        rowPlaybookId = playbookId;
      }

      const remappedRow: Record<string, string> = {};
      if (Object.keys(mapping).length > 0) {
        for (const [playbookVar, excelHeader] of Object.entries(mapping)) {
          if (typeof excelHeader === "string" && excelHeader in row) {
            remappedRow[playbookVar] = row[excelHeader];
          }
        }
      } else {
        Object.assign(remappedRow, row);
      }

      return {
        row_index: rowIndex,
        playbook_id: rowPlaybookId,
        data: {
          // What the agent ultimately sends to ${...} substitution: shared first,
          // then per-row overrides
          merged: { ...sharedData, ...remappedRow },
          // The raw Excel row (kept for audit/debug)
          raw: row,
        },
      };
    });

    const runConfig = {
      mode: "bulk" as AgentMode,
      sharedData,
      mapping,
      playbookColumn: playbookColumn ?? null,
      playbookMap: playbookMap ?? {},
      defaultPlaybookId: playbookId ?? null,
      safetyMode: isSafetyMode(safetyMode) ? safetyMode : "halt-on-dangerous",
      allowedDomains: normalizeAllowedDomains(allowedDomains),
      sessionKey: normalizeSessionKey(sessionKey),
      maxSteps: maxSteps ?? null,
      record: record !== false,
      task: typeof task === "string" ? task : null,
      stopOnFailure: !!stopOnFailure,
    };

    const run = await createBulkRun({
      companyId: req.companyId,
      config: runConfig,
      rows: seeds,
    });

    // Spawn the worker pool; mark started with the lead worker's pid
    const procs = spawnBulkWorker(run.id, req.companyId);
    await markRunStarted(run.id, procs[0]?.pid ?? 0);

    res.status(201).json({ success: true, runId: run.id });
  } catch (error) {
    sendError(res, error);
  }
});

// ── GET /agent/bulk-runs ──────────────────────────────────────────────────────
router.get("/bulk-runs", async (req: Request, res: Response) => {
  try {
    const runs = await listBulkRuns(req.companyId);
    res.json({ success: true, runs });
  } catch (error) {
    sendError(res, error);
  }
});

// ── GET /agent/bulk-runs/:id ──────────────────────────────────────────────────
router.get("/bulk-runs/:id", async (req: Request, res: Response) => {
  try {
    const data = await findBulkRunWithRows(req.companyId, req.params.id);
    if (!data) throw new HttpError(404, "Bulk run not found");
    res.json({ success: true, run: data.run, rows: data.rows });
  } catch (error) {
    sendError(res, error);
  }
});

// ── GET /agent/bulk-runs/:id/events (SSE) ─────────────────────────────────────
// Polls the DB and streams updates so the client UI stays live without WS.
router.get("/bulk-runs/:id/events", async (req: Request, res: Response) => {
  const runId = req.params.id;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: unknown) => res.write(`data: ${JSON.stringify(event)}\n\n`);

  let cursor: string | null = null;
  let lastStatus: string | null = null;
  let closed = false;

  req.on("close", () => {
    closed = true;
  });

  const tick = async () => {
    if (closed) return;
    try {
      const run = await findBulkRun(req.companyId, runId);
      if (!run) {
        send({ type: "error", message: "run not found" });
        res.end();
        return;
      }
      if (run.status !== lastStatus) {
        lastStatus = run.status;
        send({
          type: "run_status",
          status: run.status,
          ok_count: run.ok_count,
          failed_count: run.failed_count,
          total_rows: run.total_rows,
        });
      }
      const updatedRows = await listBulkRunRowsAfter(runId, cursor);
      for (const row of updatedRows) {
        send({
          type: "row_update",
          row_index: row.row_index,
          status: row.status,
          completion_state: row.completion_state,
          review_payload: row.review_payload,
          error: row.error,
          steps_taken: row.steps_taken,
          playbook_id: row.playbook_id,
        });
        const newCursor = row.finished_at ?? row.started_at;
        if (newCursor && (!cursor || newCursor > cursor)) cursor = newCursor;
      }
      // Stop polling once the run is in a terminal state
      if (["succeeded", "failed", "stalled", "cancelled"].includes(run.status)) {
        send({ type: "done", status: run.status });
        res.end();
        return;
      }
    } catch (err) {
      console.warn("[bulk events]", err);
    }
    setTimeout(tick, 1500);
  };

  void tick();
});

// ── POST /agent/bulk-runs/:id/cancel ──────────────────────────────────────────
router.post("/bulk-runs/:id/cancel", async (req: Request, res: Response) => {
  try {
    const runId = req.params.id;
    const run = await findBulkRun(req.companyId, runId);
    if (!run) throw new HttpError(404, "Bulk run not found");

    const procs = workerRegistry.get(runId) ?? [];
    for (const proc of procs) {
      if (!proc.killed) proc.kill("SIGTERM");
    }
    workerRegistry.delete(runId);

    await markRunCancelled(runId);

    // Best-effort cancellation ping
    try {
      const data = await findBulkRunWithRows(req.companyId, runId);
      if (data) {
        void notifyBulkRunComplete({
          runId,
          status: "cancelled",
          playbookName: (data.run.config as { playbookName?: string })?.playbookName ?? null,
          totalRows: data.rows.length,
          okCount: data.rows.filter((r) => r.status === "success").length,
          failedCount: data.rows.filter((r) => r.status === "failed").length,
        });
      }
    } catch {
      /* swallow — notify is best-effort */
    }

    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/bulk-runs/:id/retry-failed ────────────────────────────────────
router.post("/bulk-runs/:id/retry-failed", async (req: Request, res: Response) => {
  try {
    const runId = req.params.id;
    const run = await findBulkRun(req.companyId, runId);
    if (!run) throw new HttpError(404, "Bulk run not found");

    if (workerRegistry.has(runId)) {
      throw new HttpError(409, "Worker is already running for this bulk run");
    }

    const reset = await resetIncompleteRows(runId);
    if (reset === 0) {
      res.json({ success: true, restarted: 0, message: "Nothing to retry" });
      return;
    }

    // Re-spawn worker pool; the agents will pick up only pending rows.
    const procs = spawnBulkWorker(runId, req.companyId);
    await markRunStarted(runId, procs[0]?.pid ?? 0);
    res.json({ success: true, restarted: reset });
  } catch (error) {
    sendError(res, error);
  }
});

// ── GET /agent/bulk-runs/:id/next-row ─────────────────────────────────────────
// Worker pulls the next pending row. Returns the resolved playbook + merged data.
router.get("/bulk-runs/:id/next-row", async (req: Request, res: Response) => {
  try {
    const runId = req.params.id;
    const workerId = String(req.query.workerId ?? "");
    if (!workerId) throw new HttpError(400, "workerId query param is required");

    // Worker callback (no per-request tenant header from the spawned Python
    // process). Resolve the run internally and derive companyId from it for
    // any downstream tenant-scoped lookups.
    const run = await findBulkRunByIdInternal(runId);
    if (!run) throw new HttpError(404, "Bulk run not found");
    if (["succeeded", "failed", "stalled", "cancelled"].includes(run.status)) {
      res.json({ success: true, row: null, runStatus: run.status });
      return;
    }

    const claimed = await claimNextPendingRow(runId, workerId);
    if (!claimed) {
      res.json({ success: true, row: null, runStatus: run.status });
      return;
    }

    let playbook = null;
    if (claimed.playbook_id) {
      playbook = await findPlaybookById(run.company_id, claimed.playbook_id);
      if (playbook) assertReviewedPlaybook(playbook);
    }

    res.json({
      success: true,
      row: {
        id: claimed.id,
        row_index: claimed.row_index,
        data: claimed.data,
        playbook_id: claimed.playbook_id,
      },
      playbook,
      config: run.config,
    });
  } catch (error) {
    sendError(res, error);
  }
});

// Errors that are worth a transient retry — network blips, page-load
// timeouts, dropped DB connections, rate limits. Anything else (auth fail,
// element not found, hallucination) is treated as a permanent failure.
const TRANSIENT_ERROR_PATTERNS = [
  /econnreset/i,
  /etimedout/i,
  /econnrefused/i,
  /enotfound/i,
  /navigation timeout/i,
  /page\.goto.*timeout/i,
  /connection terminated/i,
  /connection closed/i,
  /\bnet::err_/i,
  /\b429\b/, // rate limited
  /\b503\b/, // upstream unavailable
  /\b504\b/, // gateway timeout
];

function isTransientError(message: string | null | undefined): boolean {
  if (!message) return false;
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(message));
}

const MAX_ROW_RETRIES = Number(process.env.MAX_ROW_RETRIES ?? 3);

// ── POST /agent/bulk-runs/:id/rows/:rowIndex/result ──────────────────────────
router.post("/bulk-runs/:id/rows/:rowIndex/result", async (req: Request, res: Response) => {
  try {
    const runId = req.params.id;
    const rowIndex = Number(req.params.rowIndex);
    if (!Number.isFinite(rowIndex)) throw new HttpError(400, "rowIndex must be a number");

    const {
      status,
      error,
      screenshots,
      actionLog,
      reviewPayload,
      stepsTaken,
      completionState,
      recordingPath,
      attemptCount,
    } = req.body ?? {};

    const allowed: BulkRunRowStatus[] = ["success", "failed", "skipped"];
    if (!allowed.includes(status)) {
      throw new HttpError(400, `status must be one of ${allowed.join(", ")}`);
    }

    await updateRowResult(runId, rowIndex, {
      status,
      error: typeof error === "string" ? error : null,
      screenshots: Array.isArray(screenshots) ? screenshots : undefined,
      actionLog: Array.isArray(actionLog) ? actionLog : undefined,
      reviewPayload:
        reviewPayload && typeof reviewPayload === "object" && !Array.isArray(reviewPayload)
          ? reviewPayload as Record<string, unknown>
          : undefined,
      stepsTaken: typeof stepsTaken === "number" ? stepsTaken : null,
      completionState: isCompletionState(completionState) ? completionState : null,
      recordingPath: typeof recordingPath === "string" ? recordingPath : null,
    });

    // Auto-retry transient failures: re-queue the row for the worker pool to
    // pick up again. Hard cap at MAX_ROW_RETRIES to prevent runaway loops on
    // a permanently-broken site.
    let requeued = false;
    let nextAttempt: number | null = null;
    const currentAttempt = typeof attemptCount === "number" ? attemptCount : 0;
    if (
      status === "failed" &&
      currentAttempt < MAX_ROW_RETRIES &&
      isTransientError(typeof error === "string" ? error : null)
    ) {
      nextAttempt = await requeueRowForRetry(runId, rowIndex);
      requeued = nextAttempt !== null;
      if (requeued) {
        console.log(
          `[bulk ${runId.slice(0, 8)} row ${rowIndex}] transient error — requeued (attempt ${nextAttempt}/${MAX_ROW_RETRIES})`,
        );
      }
    }

    let stoppedOnFailure = false;
    let skippedRows = 0;
    if (status === "failed" && !requeued) {
      // Worker callback — use the internal lookup (no tenant header on the
      // spawned Python process). Row-level scoping is enforced by run_id.
      const run = await findBulkRunByIdInternal(runId);
      const shouldStop = (run?.config as { stopOnFailure?: unknown } | undefined)?.stopOnFailure === true;
      if (shouldStop) {
        const reason = `stopped after row ${rowIndex} failure`;
        skippedRows = await skipPendingRowsForStoppedRun(runId, rowIndex, reason);
        await markRunFinished(runId, "failed", typeof error === "string" ? error : reason);
        stoppedOnFailure = true;
      }
    }

    res.json({ success: true, requeued, nextAttempt, stoppedOnFailure, skippedRows });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/bulk-runs/:id/heartbeat ──────────────────────────────────────
router.post("/bulk-runs/:id/heartbeat", async (req: Request, res: Response) => {
  try {
    await recordHeartbeat(req.params.id);
    res.json({ success: true });
  } catch (error) {
    sendError(res, error);
  }
});

// ── POST /agent/bulk-runs/:id/finalize ──────────────────────────────────────
// The worker calls this when it has finished iterating all rows so the run
// transitions to a terminal state. Backend computes ok/failed from row counts.
router.post("/bulk-runs/:id/finalize", async (req: Request, res: Response) => {
  try {
    const runId = req.params.id;
    // Worker callback; resolve internally then look up the rows.
    const run = await findBulkRunByIdInternal(runId);
    if (!run) throw new HttpError(404, "Bulk run not found");
    const data = await findBulkRunWithRows(run.company_id, runId);
    if (!data) throw new HttpError(404, "Bulk run not found");

    const failed = data.rows.filter((r) => r.status === "failed").length;
    const ok = data.rows.filter((r) => r.status === "success").length;
    const outcome: "succeeded" | "failed" = failed === 0 ? "succeeded" : "failed";
    await markRunFinished(runId, outcome, req.body?.error ?? null);
    workerRegistry.delete(runId);

    // Phase B e2e: if the run was dispatched from a declaration
    // submit, post the result back to rs-server so the UI flips
    // from "Submitting…" to "Submitted" / "Failed" without polling.
    // Best-effort — failures here are logged but don't fail finalize.
    const config = data.run.config as Record<string, unknown> | null;
    if (config?.source === "declaration" && typeof config.source_declaration_id === "string") {
      const declarationId = config.source_declaration_id;
      const row = data.rows[0];
      // The worker stuffs the receipt into review_payload.receipt or
      // the final action's value when the playbook completes — we
      // peek at both. If neither is set, status flips but receipt
      // stays null and the user follows up manually.
      const reviewPayload = (row?.review_payload ?? {}) as Record<string, unknown>;
      const receipt =
        typeof reviewPayload.receipt === "string"
          ? reviewPayload.receipt
          : typeof reviewPayload.declaration_number === "string"
            ? reviewPayload.declaration_number
            : null;
      try {
        const { rsServerClient } = await import("../services/rs-server-client");
        await rsServerClient.post(
          `/internal/tools/declarations/${encodeURIComponent(declarationId)}/result`,
          {
            companyId: run.company_id,
            body: {
              status: outcome === "succeeded" ? "submitted" : "failed",
              receipt,
              bulk_run_id: runId,
              error: outcome === "failed" ? (row?.error ?? "playbook failed") : null,
            },
          },
        );
        console.log(
          `[declaration callback] declaration=${declarationId} status=${outcome === "succeeded" ? "submitted" : "failed"}`,
        );
      } catch (err) {
        console.warn(
          `[declaration callback] failed to notify rs-server for declaration=${declarationId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Out-of-band completion ping (Telegram). No-op if not configured.
    void notifyBulkRunComplete({
      runId,
      status: outcome,
      playbookName: (data.run.config as { playbookName?: string })?.playbookName ?? null,
      totalRows: data.rows.length,
      okCount: ok,
      failedCount: failed,
      durationSec:
        data.run.started_at && data.run.finished_at
          ? (new Date(data.run.finished_at).getTime() - new Date(data.run.started_at).getTime()) / 1000
          : null,
    });

    res.json({ success: true, status: outcome });
  } catch (error) {
    sendError(res, error);
  }
});

// ── Stalled-run watchdog ─────────────────────────────────────────────────────
// Started from index.ts. Marks running runs as stalled if no heartbeat for >60s
// AND the worker process is gone. Failed rows are surfaced so retry-failed works.
let stalledScannerStarted = false;
export function startStalledScanner(intervalMs = 30_000, staleSeconds = 60) {
  if (stalledScannerStarted) return;
  stalledScannerStarted = true;

  const tick = async () => {
    try {
      const candidates = await findRunningRunsWithoutHeartbeat(staleSeconds);
      for (const c of candidates) {
        const procs = workerRegistry.get(c.id) ?? [];
        const anyAlive = procs.some((p) => !p.killed);
        if (anyAlive) continue; // at least one worker still here; heartbeat just lagging
        await failRunningRowsForStalledRun(c.id);
        await markRunStalled(c.id);
        console.warn(`[stalled scanner] marked run ${c.id} as stalled`);

        // Out-of-band ping so the operator knows a run died unattended.
        try {
          // Internal lookup: this is the background scanner — no tenant context.
          const run = await findBulkRunByIdInternal(c.id);
          const data = run ? await findBulkRunWithRows(run.company_id, c.id) : null;
          if (data) {
            void notifyBulkRunComplete({
              runId: c.id,
              status: "stalled",
              playbookName: (data.run.config as { playbookName?: string })?.playbookName ?? null,
              totalRows: data.rows.length,
              okCount: data.rows.filter((r) => r.status === "success").length,
              failedCount: data.rows.filter((r) => r.status === "failed").length,
            });
          }
        } catch {
          /* swallow — notify is best-effort */
        }
      }
    } catch (err) {
      console.warn("[stalled scanner]", err);
    }
  };

  setInterval(tick, intervalMs).unref();
  // Run once on startup too
  void tick();
}

export default router;
