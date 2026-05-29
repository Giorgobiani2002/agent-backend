import { query } from "../db";

export type PlaybookReviewStatus = "pending_review" | "reviewed" | "rejected";

export interface PlaybookStep {
  index: number;
  action: "navigate" | "click" | "type" | "select" | "press" | "wait" | "upload" | "assert";
  target_description: string;
  target_text?: string;
  value?: string;
  url?: string;
  wait_ms?: number;
  ts_start: number;
  ts_end: number;
  /** True for irreversible actions: final submit, send, confirm payment, delete, etc. */
  dangerous?: boolean;
  /** Why the step is marked dangerous (shown to user). */
  danger_reason?: string;
  evidence?: {
    timestampSeconds?: number;
    screenshotUrl?: string | null;
    confidence?: number;
    warning?: string | null;
  };
}

export interface PlaybookRow {
  id: string;
  name: string;
  company_id: string;
  /**
   * Stable lookup key set by the company owner (e.g. "rs.ge.invoice"),
   * unique per (company_id, country_code). Used by the AI Action Planner
   * to reference a playbook without knowing its UUID. NULL on playbooks
   * recorded before keys were added (migration 017); owners can backfill.
   */
  key: string | null;
  /**
   * ISO 3166-1 alpha-2 country code whose tax-authority portal this playbook
   * drives. Backfilled to 'GE' by migration 015 because rs.ge was the only
   * adapter when playbooks started; new playbooks should set this from the
   * company's `country_code` at creation time.
   */
  country_code: string;
  kind: "task" | "login";
  source_type: "upload" | "youtube";
  source_path: string;
  source_url: string | null;
  duration_seconds: number | null;
  status: "pending" | "analyzing" | "ready" | "failed";
  review_status: PlaybookReviewStatus;
  reviewed_at: string | null;
  rejected_at: string | null;
  extraction_warnings: string[];
  steps: PlaybookStep[];
  step_count: number;
  model: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export async function createPendingPlaybook(input: {
  companyId: string;
  name: string;
  sourceType: "upload" | "youtube";
  sourcePath: string;
  sourceUrl?: string;
  reviewStatus?: PlaybookReviewStatus;
  /**
   * Tax-authority country whose portal this playbook drives. Defaults to 'GE'
   * to keep existing callers (which all serve rs.ge) working. CIS callers
   * pass 'AM' / 'AZ' / 'KZ'.
   */
  countryCode?: string;
}): Promise<PlaybookRow> {
  const result = await query<PlaybookRow>(
    `INSERT INTO playbooks (
       company_id, name, source_type, source_path, source_url,
       status, review_status, reviewed_at, rejected_at, country_code
     )
     VALUES (
       $1, $2, $3, $4, $5,
       'pending',
       $6,
       CASE WHEN $6 = 'reviewed' THEN now() ELSE NULL END,
       CASE WHEN $6 = 'rejected' THEN now() ELSE NULL END,
       $7
     )
     RETURNING *`,
    [
      input.companyId,
      input.name,
      input.sourceType,
      input.sourcePath,
      input.sourceUrl ?? null,
      input.reviewStatus ?? "pending_review",
      input.countryCode ?? "GE",
    ],
  );
  return result.rows[0];
}

// markPlaybookAnalyzing / Ready / Failed work on a single playbook by id and
// the caller is expected to have already resolved the playbook for the
// current tenant (via findPlaybookById(companyId, id)). They're left without
// an explicit companyId param to keep the scheduler/video-pipeline call sites
// simple — those flows hold the row, not the company.

export async function markPlaybookAnalyzing(id: string): Promise<void> {
  await query(
    `UPDATE playbooks SET status = 'analyzing', updated_at = now() WHERE id = $1`,
    [id],
  );
}

export async function markPlaybookReady(
  id: string,
  steps: PlaybookStep[],
  model: string,
  durationSeconds?: number,
  extractionWarnings: string[] = [],
): Promise<PlaybookRow> {
  const result = await query<PlaybookRow>(
    `UPDATE playbooks
     SET status = 'ready', steps = $2::jsonb, step_count = $3,
         model = $4, duration_seconds = $5, extraction_warnings = $6::jsonb, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(steps), steps.length, model, durationSeconds ?? null, JSON.stringify(extractionWarnings)],
  );
  return result.rows[0];
}

export async function markPlaybookFailed(id: string, error: string): Promise<void> {
  await query(
    `UPDATE playbooks SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`,
    [id, error],
  );
}

export async function findPlaybookById(
  companyId: string,
  id: string,
): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `SELECT * FROM playbooks WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return result.rows[0] ?? null;
}

export async function findPlaybookBySourcePath(
  companyId: string,
  sourcePath: string,
): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `SELECT * FROM playbooks
       WHERE company_id = $1 AND source_path = $2
       ORDER BY created_at DESC LIMIT 1`,
    [companyId, sourcePath],
  );
  return result.rows[0] ?? null;
}

export async function listPlaybooks(companyId: string): Promise<PlaybookRow[]> {
  const result = await query<PlaybookRow>(
    `SELECT * FROM playbooks WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId],
  );
  return result.rows;
}

export async function deletePlaybook(companyId: string, id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM playbooks WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Resolve a playbook by its lookup key — used by the AI executor when it
 * converts a planned action's `playbook_key` (e.g. "rs.ge.invoice") into
 * the concrete reviewed playbook to run. Returns null when no playbook
 * with that key has been registered for this company+country yet.
 */
export async function findPlaybookByKey(
  companyId: string,
  countryCode: string,
  key: string,
): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `SELECT * FROM playbooks
       WHERE company_id = $1 AND country_code = $2 AND key = $3
       LIMIT 1`,
    [companyId, countryCode, key],
  );
  return result.rows[0] ?? null;
}

export async function setPlaybookKey(
  companyId: string,
  id: string,
  key: string | null,
): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `UPDATE playbooks SET key = $3, updated_at = now()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
    [id, companyId, key],
  );
  return result.rows[0] ?? null;
}

export async function findLoginPlaybook(companyId: string): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `SELECT * FROM playbooks
     WHERE company_id = $1
       AND kind = 'login'
       AND status = 'ready'
       AND review_status = 'reviewed'
       AND jsonb_array_length(COALESCE(steps, '[]'::jsonb)) > 0
     ORDER BY reviewed_at DESC NULLS LAST, updated_at DESC
     LIMIT 1`,
    [companyId],
  );
  return result.rows[0] ?? null;
}

export async function setPlaybookKind(
  id: string,
  kind: "task" | "login",
): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `UPDATE playbooks SET kind = $2, updated_at = now() WHERE id = $1 RETURNING *`,
    [id, kind],
  );
  return result.rows[0] ?? null;
}

/**
 * Replace a playbook's steps. Re-numbers indices on save and bumps step_count.
 * Caller is responsible for validating step shapes — we trust the route layer.
 */
export async function updatePlaybookSteps(
  id: string,
  steps: PlaybookStep[],
): Promise<PlaybookRow | null> {
  const renumbered = steps.map((s, i) => ({ ...s, index: i }));
  const result = await query<PlaybookRow>(
    `UPDATE playbooks
     SET steps = $2::jsonb, step_count = $3, updated_at = now()
         , review_status = 'reviewed', reviewed_at = now(), rejected_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id, JSON.stringify(renumbered), renumbered.length],
  );
  return result.rows[0] ?? null;
}

export async function setPlaybookReviewStatus(
  id: string,
  reviewStatus: PlaybookReviewStatus,
): Promise<PlaybookRow | null> {
  const result = await query<PlaybookRow>(
    `UPDATE playbooks
     SET review_status = $2,
         reviewed_at = CASE WHEN $2 = 'reviewed' THEN now() ELSE NULL END,
         rejected_at = CASE WHEN $2 = 'rejected' THEN now() ELSE NULL END,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, reviewStatus],
  );
  return result.rows[0] ?? null;
}
