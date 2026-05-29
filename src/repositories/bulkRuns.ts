import { query, withTransaction } from "../db";
import type { ExecutionCompletionState } from "../types/execution";

export type BulkRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "stalled"
  | "cancelled";

export type BulkRunRowStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "skipped";

export interface BulkRunRow {
  id: string;
  run_id: string;
  row_index: number;
  status: BulkRunRowStatus;
  completion_state: ExecutionCompletionState | null;
  playbook_id: string | null;
  data: Record<string, unknown>;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  screenshots: unknown[];
  action_log: unknown[];
  review_payload: Record<string, unknown>;
  steps_taken: number | null;
  recording_path: string | null;
  worker_id: string | null;
  lock_version: number;
  attempt_count: number;
}

export interface BulkRun {
  id: string;
  company_id: string;
  status: BulkRunStatus;
  total_rows: number;
  ok_count: number;
  failed_count: number;
  config: Record<string, unknown>;
  error: string | null;
  worker_pid: number | null;
  last_heartbeat_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RowSeed {
  row_index: number;
  playbook_id: string | null;
  data: Record<string, unknown>;
}

export async function createBulkRun(input: {
  companyId: string;
  config: Record<string, unknown>;
  rows: RowSeed[];
}): Promise<BulkRun> {
  return withTransaction(async (client) => {
    const runRes = await client.query<BulkRun>(
      `INSERT INTO bulk_runs (company_id, status, total_rows, config)
       VALUES ($1, 'pending', $2, $3::jsonb)
       RETURNING *`,
      [input.companyId, input.rows.length, JSON.stringify(input.config)],
    );
    const run = runRes.rows[0];

    if (input.rows.length > 0) {
      // Build a single multi-row INSERT for efficiency
      const placeholders: string[] = [];
      const values: unknown[] = [];
      let p = 1;
      for (const row of input.rows) {
        placeholders.push(
          `($${p++}::uuid, $${p++}::int, $${p++}::uuid, $${p++}::jsonb)`,
        );
        values.push(run.id, row.row_index, row.playbook_id, JSON.stringify(row.data));
      }
      await client.query(
        `INSERT INTO bulk_run_rows (run_id, row_index, playbook_id, data)
         VALUES ${placeholders.join(", ")}`,
        values,
      );
    }

    return run;
  });
}

export async function findBulkRun(
  companyId: string,
  id: string,
): Promise<BulkRun | null> {
  const res = await query<BulkRun>(
    `SELECT * FROM bulk_runs WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return res.rows[0] ?? null;
}

/**
 * Internal lookup that does NOT enforce tenant scoping — only used by the
 * scheduler / stalled-scanner / bulk worker, all of which are server-side
 * jobs that already trust the row id (it came from claim*). Never call from
 * a route handler.
 */
export async function findBulkRunByIdInternal(id: string): Promise<BulkRun | null> {
  const res = await query<BulkRun>(`SELECT * FROM bulk_runs WHERE id = $1`, [id]);
  return res.rows[0] ?? null;
}

export async function findBulkRunWithRows(
  companyId: string,
  id: string,
): Promise<{ run: BulkRun; rows: BulkRunRow[] } | null> {
  const run = await findBulkRun(companyId, id);
  if (!run) return null;
  const rowsRes = await query<BulkRunRow>(
    `SELECT * FROM bulk_run_rows WHERE run_id = $1 ORDER BY row_index ASC`,
    [id],
  );
  return { run, rows: rowsRes.rows };
}

export async function listBulkRuns(companyId: string, limit = 100): Promise<BulkRun[]> {
  const res = await query<BulkRun>(
    `SELECT * FROM bulk_runs
       WHERE company_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
    [companyId, limit],
  );
  return res.rows;
}

export async function listBulkRunRowsAfter(
  runId: string,
  afterUpdatedAt: string | null,
): Promise<BulkRunRow[]> {
  // Live tail: rows whose finished_at OR started_at is newer than the cursor.
  // For simplicity we return all rows on first call (afterUpdatedAt=null).
  if (!afterUpdatedAt) {
    const res = await query<BulkRunRow>(
      `SELECT * FROM bulk_run_rows WHERE run_id = $1 ORDER BY row_index ASC`,
      [runId],
    );
    return res.rows;
  }
  const res = await query<BulkRunRow>(
    `SELECT * FROM bulk_run_rows
     WHERE run_id = $1
       AND (started_at > $2 OR finished_at > $2)
     ORDER BY row_index ASC`,
    [runId, afterUpdatedAt],
  );
  return res.rows;
}

/**
 * Atomically claim the next pending row for the given worker. Uses
 * `SELECT ... FOR UPDATE SKIP LOCKED` so a future concurrent worker pool is safe.
 */
export async function claimNextPendingRow(
  runId: string,
  workerId: string,
): Promise<BulkRunRow | null> {
  return withTransaction(async (client) => {
    const claim = await client.query<BulkRunRow>(
      `SELECT * FROM bulk_run_rows
       WHERE run_id = $1 AND status IN ('pending')
       ORDER BY row_index ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [runId],
    );
    const row = claim.rows[0];
    if (!row) return null;

    const updated = await client.query<BulkRunRow>(
      `UPDATE bulk_run_rows
       SET status = 'running',
           worker_id = $1::uuid,
           started_at = now(),
           lock_version = lock_version + 1
       WHERE id = $2
       RETURNING *`,
      [workerId, row.id],
    );
    return updated.rows[0];
  });
}

/**
 * Re-queue a failed row for retry. Bumps attempt_count, resets status to
 * 'pending', clears worker_id/started_at/finished_at so claimNextPendingRow
 * picks it up. Returns the new attempt_count, or null if the row was not
 * found or was not retryable.
 */
export async function requeueRowForRetry(
  runId: string,
  rowIndex: number,
): Promise<number | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ attempt_count: number }>(
      `UPDATE bulk_run_rows
       SET status = 'pending',
           completion_state = NULL,
           worker_id = NULL,
           started_at = NULL,
           finished_at = NULL,
           attempt_count = attempt_count + 1,
           lock_version = lock_version + 1
       WHERE run_id = $1 AND row_index = $2 AND status = 'failed'
       RETURNING attempt_count`,
      [runId, rowIndex],
    );
    return result.rows[0]?.attempt_count ?? null;
  });
}

export interface RowResultUpdate {
  status: BulkRunRowStatus;
  completionState?: ExecutionCompletionState | null;
  error?: string | null;
  screenshots?: unknown[];
  actionLog?: unknown[];
  reviewPayload?: Record<string, unknown>;
  stepsTaken?: number | null;
  recordingPath?: string | null;
}

export async function updateRowResult(
  runId: string,
  rowIndex: number,
  update: RowResultUpdate,
): Promise<void> {
  const incOk = update.status === "success" ? 1 : 0;
  const incFail = update.status === "failed" ? 1 : 0;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE bulk_run_rows
       SET status = $1,
           error = $2,
           screenshots = COALESCE($3::jsonb, screenshots),
           action_log = COALESCE($4::jsonb, action_log),
           steps_taken = COALESCE($5::int, steps_taken),
           recording_path = COALESCE($6, recording_path),
           completion_state = COALESCE($7, completion_state),
           review_payload = COALESCE($8::jsonb, review_payload),
           finished_at = now(),
           lock_version = lock_version + 1
       WHERE run_id = $9 AND row_index = $10`,
      [
        update.status,
        update.error ?? null,
        update.screenshots ? JSON.stringify(update.screenshots) : null,
        update.actionLog ? JSON.stringify(update.actionLog) : null,
        update.stepsTaken ?? null,
        update.recordingPath ?? null,
        update.completionState ?? null,
        update.reviewPayload ? JSON.stringify(update.reviewPayload) : null,
        runId,
        rowIndex,
      ],
    );

    if (incOk || incFail) {
      await client.query(
        `UPDATE bulk_runs
         SET ok_count = ok_count + $1,
             failed_count = failed_count + $2,
             updated_at = now()
         WHERE id = $3`,
        [incOk, incFail, runId],
      );
    }
  });
}

/**
 * Mark a single bulk-run row as skipped with a human-supplied reason.
 * Used by the `skip_bulk_row` chat tool when the operator decides a
 * failed row is irrecoverable and should be excluded from retries.
 * Tenant-scoped at the agent-runs / chat-tool layer.
 */
export async function skipBulkRow(
  runId: string,
  rowIndex: number,
  reason: string,
): Promise<{ status: string } | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ status: string; prev_status: string }>(
      `UPDATE bulk_run_rows
         SET status = 'skipped',
             error = COALESCE(error, '') ||
                     CASE WHEN error IS NULL OR error = '' THEN '' ELSE E'\\n' END ||
                     'skipped: ' || $3,
             finished_at = COALESCE(finished_at, now()),
             lock_version = lock_version + 1
         WHERE run_id = $1 AND row_index = $2
           AND status IN ('failed', 'pending')
         RETURNING status, status AS prev_status`,
      [runId, rowIndex, reason],
    );
    return result.rows[0] ?? null;
  });
}

export async function skipPendingRowsForStoppedRun(
  runId: string,
  failedRowIndex: number,
  reason: string,
): Promise<number> {
  const res = await query(
    `UPDATE bulk_run_rows
     SET status = 'skipped',
         error = $2,
         finished_at = now(),
         lock_version = lock_version + 1
     WHERE run_id = $1 AND status = 'pending' AND row_index > $3`,
    [runId, reason, failedRowIndex],
  );
  return res.rowCount ?? 0;
}

export async function markRunStarted(runId: string, workerPid: number): Promise<void> {
  await query(
    `UPDATE bulk_runs
     SET status = 'running',
         worker_pid = $2,
         started_at = COALESCE(started_at, now()),
         last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [runId, workerPid],
  );
}

export async function markRunFinished(
  runId: string,
  outcome: "succeeded" | "failed",
  errorMessage?: string,
): Promise<void> {
  await query(
    `UPDATE bulk_runs
     SET status = $2,
         error = CASE
           WHEN $3 IS NOT NULL THEN $3
           WHEN $2 = 'succeeded' THEN NULL
           ELSE error
         END,
         finished_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [runId, outcome, errorMessage ?? null],
  );
}

export async function markRunStalled(runId: string): Promise<void> {
  await query(
    `UPDATE bulk_runs
     SET status = 'stalled',
         updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [runId],
  );
}

export async function markRunCancelled(runId: string): Promise<void> {
  await query(
    `UPDATE bulk_runs
     SET status = 'cancelled',
         finished_at = COALESCE(finished_at, now()),
         updated_at = now()
     WHERE id = $1 AND status IN ('pending', 'running', 'stalled')`,
    [runId],
  );
}

/** Reset failed/stalled rows back to pending so a re-spawned worker can pick them up. */
export async function resetIncompleteRows(runId: string): Promise<number> {
  const res = await query(
    `UPDATE bulk_run_rows
     SET status = 'pending',
         error = NULL,
         completion_state = NULL,
         worker_id = NULL,
         started_at = NULL,
         finished_at = NULL,
         lock_version = lock_version + 1
     WHERE run_id = $1 AND status IN ('failed', 'running')`,
    [runId],
  );
  return res.rowCount ?? 0;
}

export async function recordHeartbeat(runId: string): Promise<void> {
  await query(
    `UPDATE bulk_runs
     SET last_heartbeat_at = now(),
         updated_at = now()
     WHERE id = $1 AND status = 'running'`,
    [runId],
  );
}

export interface StalledCandidate {
  id: string;
  worker_pid: number | null;
  last_heartbeat_at: string | null;
}

export async function findRunningRunsWithoutHeartbeat(
  staleSeconds: number,
): Promise<StalledCandidate[]> {
  const res = await query<StalledCandidate>(
    `SELECT id, worker_pid, last_heartbeat_at FROM bulk_runs
     WHERE status = 'running'
       AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - ($1 || ' seconds')::interval)`,
    [String(staleSeconds)],
  );
  return res.rows;
}

/** Mark all currently-running rows in a stalled run as failed. */
export async function failRunningRowsForStalledRun(runId: string): Promise<void> {
  await query(
    `UPDATE bulk_run_rows
     SET status = 'failed',
         completion_state = COALESCE(completion_state, 'failed'),
         error = COALESCE(error, 'worker stalled'),
         finished_at = COALESCE(finished_at, now()),
         lock_version = lock_version + 1
     WHERE run_id = $1 AND status = 'running'`,
    [runId],
  );
  await query(
    `UPDATE bulk_runs
     SET failed_count = failed_count + (
           SELECT count(*) FROM bulk_run_rows
           WHERE run_id = $1 AND status = 'failed' AND error = 'worker stalled'
         )
     WHERE id = $1`,
    [runId],
  );
}
