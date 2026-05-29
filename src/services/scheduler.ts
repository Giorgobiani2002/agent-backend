/**
 * Cron-based scheduler for `scheduled_runs`.
 *
 * Ticks every SCHEDULER_TICK_MS (default 60s). On each tick:
 *   1. Atomically claim all due schedules (next_run_at <= now AND enabled).
 *   2. For each: create a single-row bulk_run with the schedule's data,
 *      spawn the worker, and record the next_run_at from the cron expression.
 *
 * Disabled with SCHEDULER_ENABLED=false.
 */

import { CronExpressionParser } from "cron-parser";
import { ChildProcess } from "child_process";
import {
  claimDueScheduledRuns,
  recordScheduleFiringResult,
  type ScheduledRunRow,
} from "../repositories/scheduledRuns";
import { createBulkRun, markRunStarted } from "../repositories/bulkRuns";

let started = false;

/**
 * Compute the next firing time for a cron expression. Returns null on
 * invalid expressions so callers can disable the schedule cleanly.
 */
export function computeNextRunAt(
  cronExpression: string,
  timezone: string | null,
  reference?: Date,
): Date | null {
  try {
    const it = CronExpressionParser.parse(cronExpression, {
      currentDate: reference ?? new Date(),
      tz: timezone ?? undefined,
    });
    return it.next().toDate();
  } catch {
    return null;
  }
}

/**
 * Validate a cron expression — returns true if cron-parser accepts it.
 * Used by the create/update endpoints to reject bad input early.
 */
export function isValidCronExpression(expr: string, timezone?: string | null): boolean {
  try {
    CronExpressionParser.parse(expr, { tz: timezone ?? undefined });
    return true;
  } catch {
    return false;
  }
}

export interface SchedulerDeps {
  /**
   * Spawns the bulk worker pool for a freshly-created bulk_run id.
   * Injected from `routes/agent.ts` so we don't re-import the heavy spawn
   * machinery (and to avoid circular module deps).
   */
  spawnBulkWorker: (runId: string, companyId: string, concurrency?: number) => ChildProcess[];
}

let depsRef: SchedulerDeps | null = null;

export function startScheduler(deps: SchedulerDeps, intervalMs?: number): void {
  if (started) return;
  if (process.env.SCHEDULER_ENABLED === "false") {
    console.log("[scheduler] disabled via SCHEDULER_ENABLED=false");
    return;
  }
  started = true;
  depsRef = deps;
  const tickMs = intervalMs ?? Number(process.env.SCHEDULER_TICK_MS ?? "60000");
  console.log(`[scheduler] starting (tick every ${tickMs}ms)`);

  const tick = async () => {
    try {
      await runOneTick();
    } catch (err) {
      console.warn("[scheduler] tick error:", err instanceof Error ? err.message : err);
    }
  };

  // Fire once on startup so newly-due schedules don't have to wait a full tick.
  void tick();
  setInterval(() => void tick(), tickMs).unref();
}

/** One tick: claim due schedules and fire each. Exported for test harness. */
export async function runOneTick(): Promise<void> {
  // Alert sweep is best-effort + isolated — never let it block schedule
  // firing. The dynamic import dodges the cycle that would happen if we
  // top-imported alert-generator (which transitively touches scheduler-
  // adjacent repos).
  try {
    const { runAlertSweep } = await import("./alert-generator");
    await runAlertSweep();
  } catch (err) {
    console.warn(
      "[scheduler] alert sweep failed:",
      err instanceof Error ? err.message : err,
    );
  }

  const due = await claimDueScheduledRuns(new Date());
  if (due.length === 0) return;
  console.log(`[scheduler] firing ${due.length} schedule(s)`);

  for (const schedule of due) {
    await fireScheduledRun(schedule);
  }
}

async function fireScheduledRun(schedule: ScheduledRunRow): Promise<void> {
  const nextAt = computeNextRunAt(schedule.cron_expression, schedule.timezone);
  let bulkRunId = "";
  let outcome: "succeeded" | "failed" | "spawn_error" = "spawn_error";

  try {
    if (!depsRef) throw new Error("scheduler deps not injected");

    // Single-row bulk run. The cron data IS the row data.
    const seeds = [
      {
        row_index: 0,
        playbook_id: schedule.playbook_id,
        data: { merged: schedule.data, raw: schedule.data },
      },
    ];
    const runConfig = {
      sharedData: schedule.data,
      mapping: {},
      playbookColumn: null,
      playbookMap: {},
      defaultPlaybookId: schedule.playbook_id,
      safetyMode: schedule.safety_mode,
      maxSteps: null,
      record: true,
      task: null,
      stopOnFailure: false,
      // Audit trail: link the bulk run back to the schedule that spawned it.
      scheduleId: schedule.id,
      scheduleName: schedule.name,
    };

    const run = await createBulkRun({
      companyId: schedule.company_id,
      config: runConfig,
      rows: seeds,
    });
    bulkRunId = run.id;
    const procs = depsRef.spawnBulkWorker(run.id, schedule.company_id, 1);
    await markRunStarted(run.id, procs[0]?.pid ?? 0);

    // We can't know the outcome yet — bulk run runs async. The finalize
    // endpoint will trigger Telegram notification with the real result. For
    // the schedule row, we mark "succeeded" optimistically (= spawn worked)
    // and let the operator look at last_bulk_run_id for actual outcome.
    outcome = "succeeded";
    console.log(`[scheduler] fired ${schedule.name} → bulk run ${run.id}`);
  } catch (err) {
    console.warn(
      `[scheduler] fire failed for schedule ${schedule.id} (${schedule.name}):`,
      err instanceof Error ? err.message : err,
    );
    outcome = "spawn_error";
  } finally {
    await recordScheduleFiringResult(schedule.id, bulkRunId || null, outcome, nextAt).catch(
      (err) => console.warn("[scheduler] failed to record result:", err),
    );
  }
}
