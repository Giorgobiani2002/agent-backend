import { query } from "../db";

export interface ScheduledRunRow {
  id: string;
  name: string;
  company_id: string;
  playbook_id: string;
  cron_expression: string;
  data: Record<string, unknown>;
  safety_mode: "auto" | "halt-on-dangerous" | "dry-run";
  enabled: boolean;
  timezone: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_bulk_run_id: string | null;
  total_runs: number;
  total_failures: number;
  created_at: string;
  updated_at: string;
}

export async function listScheduledRuns(companyId: string): Promise<ScheduledRunRow[]> {
  const r = await query<ScheduledRunRow>(
    `SELECT * FROM scheduled_runs
       WHERE company_id = $1
       ORDER BY enabled DESC, next_run_at ASC NULLS LAST`,
    [companyId],
  );
  return r.rows;
}

export async function findScheduledRunById(
  companyId: string,
  id: string,
): Promise<ScheduledRunRow | null> {
  const r = await query<ScheduledRunRow>(
    `SELECT * FROM scheduled_runs WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return r.rows[0] ?? null;
}

export interface CreateScheduledRunInput {
  companyId: string;
  name: string;
  playbookId: string;
  cronExpression: string;
  data?: Record<string, unknown>;
  safetyMode?: "auto" | "halt-on-dangerous" | "dry-run";
  enabled?: boolean;
  timezone?: string | null;
  nextRunAt: Date;
}

export async function createScheduledRun(input: CreateScheduledRunInput): Promise<ScheduledRunRow> {
  const r = await query<ScheduledRunRow>(
    `INSERT INTO scheduled_runs
       (company_id, name, playbook_id, cron_expression, data, safety_mode, enabled, timezone, next_run_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.companyId,
      input.name,
      input.playbookId,
      input.cronExpression,
      JSON.stringify(input.data ?? {}),
      input.safetyMode ?? "auto",
      input.enabled ?? true,
      input.timezone ?? null,
      input.nextRunAt,
    ],
  );
  return r.rows[0];
}

export interface UpdateScheduledRunInput {
  name?: string;
  cronExpression?: string;
  data?: Record<string, unknown>;
  safetyMode?: "auto" | "halt-on-dangerous" | "dry-run";
  enabled?: boolean;
  timezone?: string | null;
  nextRunAt?: Date | null;
}

export async function updateScheduledRun(
  companyId: string,
  id: string,
  input: UpdateScheduledRunInput,
): Promise<ScheduledRunRow | null> {
  // Build a dynamic SET clause; only update fields that are provided.
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) { sets.push(`name = $${i++}`); params.push(input.name); }
  if (input.cronExpression !== undefined) { sets.push(`cron_expression = $${i++}`); params.push(input.cronExpression); }
  if (input.data !== undefined) { sets.push(`data = $${i++}::jsonb`); params.push(JSON.stringify(input.data)); }
  if (input.safetyMode !== undefined) { sets.push(`safety_mode = $${i++}`); params.push(input.safetyMode); }
  if (input.enabled !== undefined) { sets.push(`enabled = $${i++}`); params.push(input.enabled); }
  if (input.timezone !== undefined) { sets.push(`timezone = $${i++}`); params.push(input.timezone); }
  if (input.nextRunAt !== undefined) { sets.push(`next_run_at = $${i++}`); params.push(input.nextRunAt); }
  if (sets.length === 0) return await findScheduledRunById(companyId, id);
  sets.push(`updated_at = now()`);
  params.push(id);
  params.push(companyId);

  const r = await query<ScheduledRunRow>(
    `UPDATE scheduled_runs SET ${sets.join(", ")} WHERE id = $${i++} AND company_id = $${i} RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function deleteScheduledRun(companyId: string, id: string): Promise<boolean> {
  const r = await query(
    `DELETE FROM scheduled_runs WHERE id = $1 AND company_id = $2`,
    [id, companyId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Atomically claim due schedules so a parallel scheduler cannot double-fire.
 * Returns rows for ALL companies — this runs from the global scheduler tick.
 * Each returned row carries company_id, so the caller can spawn the bulk run
 * scoped to the right tenant.
 */
export async function claimDueScheduledRuns(now: Date): Promise<ScheduledRunRow[]> {
  const r = await query<ScheduledRunRow>(
    `UPDATE scheduled_runs
     SET next_run_at = NULL,
         last_run_at = now(),
         total_runs = total_runs + 1,
         updated_at = now()
     WHERE id IN (
       SELECT id FROM scheduled_runs
       WHERE enabled = true
         AND next_run_at IS NOT NULL
         AND next_run_at <= $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [now],
  );
  return r.rows;
}

export async function recordScheduleFiringResult(
  id: string,
  bulkRunId: string | null,
  outcome: "succeeded" | "failed" | "spawn_error",
  nextRunAt: Date | null,
): Promise<void> {
  const isFailure = outcome !== "succeeded";
  await query(
    `UPDATE scheduled_runs
     SET last_bulk_run_id = $1,
         last_run_status = $2,
         next_run_at = $3,
         total_failures = total_failures + $4,
         updated_at = now()
     WHERE id = $5`,
    [bulkRunId, outcome, nextRunAt, isFailure ? 1 : 0, id],
  );
}
