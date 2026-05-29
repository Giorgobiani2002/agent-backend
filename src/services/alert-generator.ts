import crypto from "crypto";
import { query } from "../db";
import {
  autoResolveQuietAlerts,
  upsertAlert,
  type AlertSeverity,
  type AlertSuggestedAction,
} from "../repositories/alerts";

/**
 * Alert generator — runs on the scheduler tick (services/scheduler.ts)
 * every ~60s. Sweeps failure feeds and UPSERTs into the alerts table
 * keyed on `dedup_key` so a recurring failure bumps `count` instead of
 * creating duplicate rows.
 *
 * Three sweeps today:
 *
 *   1. **failed_bulk_rows**: group bulk_run_rows.status='failed' in the
 *      last 15 minutes by (company, error_class). One alert per group.
 *
 *   2. **stuck_pending_agent_runs**: agent_runs sitting in
 *      'pending_review' longer than 1h — they need human eyes.
 *
 *   3. **stalled_bulk_runs**: bulk_runs that the heartbeat watchdog
 *      flipped to 'stalled' in the last hour.
 *
 * Each generator returns a structured `Finding[]` and the caller
 * UPSERTs into `alerts`. Keeping the generators pure makes them
 * trivially testable.
 *
 * NOTE on rs-server sweeps (pipeline runs + declarations): not yet
 * implemented — would require an aggregated /internal/tools/failures-
 * since endpoint on rs-server. The agent-backend feeds cover the
 * highest-value cases (bulk-row failures driving waybill submissions),
 * so the surface is useful as-is. Track follow-up under "Slice B+".
 */

export interface AlertFinding {
  companyId: string;
  kind: string;
  severity: AlertSeverity;
  entityType?: string | null;
  entityId?: string | null;
  count: number;
  title: string;
  suggestedActions: AlertSuggestedAction[];
  dedupKey: string;
  metadata: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function dedupKey(parts: Array<string | number | null | undefined>): string {
  // Hash so the key stays a fixed length regardless of how many entity
  // ids end up in the bucket. SHA1 is fine here — no security purpose.
  const raw = parts.map((p) => (p ?? "")).join("|");
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function todayBucket(): string {
  // Date-bucketing prevents yesterday's alert from absorbing today's
  // new failures — each day gets a fresh "open" row.
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

/**
 * Bucket a free-form error message into a category so we group "the
 * same kind of failure" together. Patterns are ordered most-specific
 * first. Defaults to "unknown" so the model can still summarise.
 */
export function classifyErrorText(error: string | null | undefined): string {
  if (!error) return "unknown";
  const s = error.toLowerCase();
  // Order matters. POSIX error codes (ETIMEDOUT, ECONNRESET) are network
  // reachability failures — match those first before the generic
  // "timeout" word so the suggested fix matches the actual cause.
  if (/(etimedout|econnreset|enotfound|socket hang up)/.test(s)) {
    return "network";
  }
  if (/\b(timeout|timed[ -]?out)\b/.test(s)) return "timeout";
  if (/\bnetwork\b/.test(s)) return "network";
  if (/(rate.?limit|429|too many requests)/.test(s)) return "rate_limit";
  if (/(401|403|unauthor|forbidden|access denied)/.test(s)) return "auth";
  if (/(5\d\d|server error|bad gateway|service unavailable)/.test(s)) {
    return "portal_error";
  }
  if (/(invalid|malformed|missing|required|validation)/.test(s)) {
    return "validation";
  }
  if (/(captcha|robot|recaptcha)/.test(s)) return "captcha";
  return "unknown";
}

// ── Sweep 1: failed bulk rows ───────────────────────────────────────────

interface FailedBulkRow {
  company_id: string;
  run_id: string;
  row_index: number;
  playbook_id: string | null;
  error: string | null;
  finished_at: string;
}

export async function sweepFailedBulkRows(
  windowMinutes = 15,
): Promise<AlertFinding[]> {
  const rows = await query<FailedBulkRow>(
    `
      SELECT br.company_id, r.run_id, r.row_index, r.playbook_id,
             r.error, r.finished_at::text
        FROM bulk_run_rows r
        JOIN bulk_runs br ON br.id = r.run_id
       WHERE r.status = 'failed'
         AND r.finished_at >= now() - ($1 || ' minutes')::interval
       ORDER BY r.finished_at DESC
       LIMIT 5000
    `,
    [String(windowMinutes)],
  );

  // Group by (company, error_class). Suggested actions vary by class:
  // network/timeout → retry_bulk_row; portal_error → check rs.ge; etc.
  const groups = new Map<
    string,
    {
      companyId: string;
      errorClass: string;
      rows: FailedBulkRow[];
    }
  >();
  for (const row of rows.rows) {
    const cls = classifyErrorText(row.error);
    const k = `${row.company_id}::${cls}`;
    if (!groups.has(k)) {
      groups.set(k, { companyId: row.company_id, errorClass: cls, rows: [] });
    }
    groups.get(k)!.rows.push(row);
  }

  const findings: AlertFinding[] = [];
  for (const { companyId, errorClass, rows: bucket } of groups.values()) {
    if (bucket.length === 0) continue;
    const severity: AlertSeverity =
      bucket.length >= 50 ? "critical" : bucket.length >= 10 ? "warn" : "info";

    const sampleError = (bucket[0].error ?? "").slice(0, 200);
    const title =
      bucket.length === 1
        ? `1 bulk run row failed — ${errorClass}`
        : `${bucket.length} bulk run rows failed — ${errorClass}`;

    // Transient classes get a one-click retry-all action; others get
    // a deep link via the chat tool that lists the rows.
    const isTransient = ["network", "timeout", "rate_limit", "portal_error"].includes(
      errorClass,
    );
    const suggestedActions: AlertSuggestedAction[] = isTransient
      ? [
          // Slice C will wire `retry_bulk_failed` as a write tool; for
          // now the UI shows this as a deep link to the bulk run page
          // where the existing "Retry failed" button already works.
          {
            tool: "list_failed_bulk_rows",
            args: {
              sinceHours: Math.ceil(windowMinutes / 60) || 1,
              limit: 100,
            },
            label: "Show all failed rows",
          },
        ]
      : [
          {
            tool: "list_failed_bulk_rows",
            args: { sinceHours: 24, limit: 100 },
            label: "Show recent failed rows",
          },
        ];

    findings.push({
      companyId,
      kind: "bulk_rows_failing",
      severity,
      entityType: "bulk_run",
      // If every failed row belongs to the same run, point at it so
      // the contextual banner on /dashboard/ai/runs/:id lights up.
      entityId:
        new Set(bucket.map((r) => r.run_id)).size === 1 ? bucket[0].run_id : null,
      count: bucket.length,
      title,
      suggestedActions,
      dedupKey: dedupKey([
        companyId,
        "bulk_rows_failing",
        errorClass,
        todayBucket(),
      ]),
      metadata: {
        error_class: errorClass,
        sample_error: sampleError,
        run_ids: Array.from(new Set(bucket.map((r) => r.run_id))).slice(0, 20),
        row_count: bucket.length,
      },
    });
  }
  return findings;
}

// ── Sweep 2: pending review piling up ───────────────────────────────────

interface PendingAgentRunRow {
  id: string;
  company_id: string;
  category: string;
  tax_risk: string;
  amount: string | null;
  currency: string | null;
  created_at: string;
}

export async function sweepStuckPendingAgentRuns(
  olderThanHours = 1,
): Promise<AlertFinding[]> {
  const rows = await query<PendingAgentRunRow>(
    `
      SELECT id, company_id, category, tax_risk, amount::text, currency, created_at::text
        FROM agent_runs
       WHERE status = 'pending_review'
         AND created_at < now() - ($1 || ' hours')::interval
       ORDER BY created_at ASC
       LIMIT 2000
    `,
    [String(olderThanHours)],
  );
  if (rows.rows.length === 0) return [];

  const byCompany = new Map<string, PendingAgentRunRow[]>();
  for (const r of rows.rows) {
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, []);
    byCompany.get(r.company_id)!.push(r);
  }

  const findings: AlertFinding[] = [];
  for (const [companyId, items] of byCompany) {
    const highRisk = items.filter((r) =>
      r.tax_risk === "high" || r.tax_risk === "medium",
    );
    const severity: AlertSeverity =
      highRisk.length > 0
        ? "critical"
        : items.length >= 5
          ? "warn"
          : "info";
    const title =
      items.length === 1
        ? `1 AI decision waiting for review`
        : `${items.length} AI decisions waiting for review`;

    findings.push({
      companyId,
      kind: "pending_agent_runs",
      severity,
      entityType: null,
      entityId: null,
      count: items.length,
      title,
      suggestedActions: [
        {
          tool: "list_agent_runs",
          args: { status: "pending_review", limit: 50 },
          label: "Open approval queue",
        },
      ],
      dedupKey: dedupKey([companyId, "pending_agent_runs", todayBucket()]),
      metadata: {
        oldest_at: items[0].created_at,
        high_risk_count: highRisk.length,
        ids: items.slice(0, 20).map((r) => r.id),
      },
    });
  }
  return findings;
}

// ── Sweep 3: stalled bulk runs ──────────────────────────────────────────

interface StalledRunRow {
  id: string;
  company_id: string;
  total_rows: number;
  ok_count: number;
  failed_count: number;
  last_heartbeat_at: string | null;
}

export async function sweepStalledBulkRuns(): Promise<AlertFinding[]> {
  const rows = await query<StalledRunRow>(
    `
      SELECT id, company_id, total_rows, ok_count, failed_count,
             last_heartbeat_at::text
        FROM bulk_runs
       WHERE status = 'stalled'
         AND COALESCE(finished_at, now()) >= now() - INTERVAL '24 hours'
       ORDER BY created_at DESC
       LIMIT 500
    `,
  );
  return rows.rows.map((r) => ({
    companyId: r.company_id,
    kind: "bulk_run_stalled",
    severity: "critical" as AlertSeverity,
    entityType: "bulk_run",
    entityId: r.id,
    count: 1,
    title: `Bulk run stalled — no worker heartbeat`,
    suggestedActions: [
      {
        tool: "get_bulk_run",
        args: { runId: r.id },
        label: "Inspect run",
      },
    ],
    dedupKey: dedupKey([r.company_id, "bulk_run_stalled", r.id]),
    metadata: {
      total_rows: r.total_rows,
      ok_count: r.ok_count,
      failed_count: r.failed_count,
      last_heartbeat_at: r.last_heartbeat_at,
    },
  }));
}

// ── Orchestrator ────────────────────────────────────────────────────────

export interface AlertSweepResult {
  inserted: number;
  resolvedQuiet: number;
}

export async function runAlertSweep(): Promise<AlertSweepResult> {
  const findings = (
    await Promise.all([
      sweepFailedBulkRows().catch((err) => {
        console.warn("[alerts] sweepFailedBulkRows failed:", err);
        return [] as AlertFinding[];
      }),
      sweepStuckPendingAgentRuns().catch((err) => {
        console.warn("[alerts] sweepStuckPendingAgentRuns failed:", err);
        return [] as AlertFinding[];
      }),
      sweepStalledBulkRuns().catch((err) => {
        console.warn("[alerts] sweepStalledBulkRuns failed:", err);
        return [] as AlertFinding[];
      }),
    ])
  ).flat();

  let inserted = 0;
  for (const f of findings) {
    try {
      await upsertAlert({
        companyId: f.companyId,
        kind: f.kind,
        severity: f.severity,
        entityType: f.entityType,
        entityId: f.entityId,
        incrementBy: f.count,
        title: f.title,
        suggestedActions: f.suggestedActions,
        dedupKey: f.dedupKey,
        metadata: f.metadata,
      });
      inserted++;
    } catch (err) {
      console.warn(
        "[alerts] upsert failed for",
        f.kind,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const resolvedQuiet = await autoResolveQuietAlerts(6).catch((err) => {
    console.warn("[alerts] autoResolveQuietAlerts failed:", err);
    return 0;
  });

  return { inserted, resolvedQuiet };
}
