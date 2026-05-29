import { query } from "../db";

/**
 * Repository for the `alerts` table (migration 018).
 *
 * Used by:
 *   - the alert generator that sweeps failure feeds and UPSERTs alerts
 *     by dedup_key (services/alert-generator.ts);
 *   - the alerts REST surface that the topbar badge + /dashboard/alerts
 *     page poll (routes/alerts.ts);
 *   - chat tools `list_alerts` / `get_alert` / `acknowledge_alert` /
 *     `snooze_alert` (services/chat-tools.ts).
 */

export type AlertSeverity = "info" | "warn" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved" | "snoozed";

export interface AlertSuggestedAction {
  /** Chat-tool name to dispatch when the user clicks the button. */
  tool: string;
  /** Args pre-filled for that tool. */
  args: Record<string, unknown>;
  /** Button label shown to the user. */
  label: string;
}

export interface AlertRow {
  id: string;
  company_id: string;
  kind: string;
  severity: AlertSeverity;
  entity_type: string | null;
  entity_id: string | null;
  count: number;
  title: string;
  root_cause: string | null;
  suggested_actions: AlertSuggestedAction[];
  status: AlertStatus;
  first_seen_at: string;
  last_seen_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  snoozed_until: string | null;
  dedup_key: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UpsertAlertInput {
  companyId: string;
  kind: string;
  severity: AlertSeverity;
  entityType?: string | null;
  entityId?: string | null;
  /** Number of newly-observed underlying failures this sweep. */
  incrementBy?: number;
  title: string;
  rootCause?: string | null;
  suggestedActions?: AlertSuggestedAction[];
  dedupKey: string;
  metadata?: Record<string, unknown>;
}

/**
 * UPSERT keyed on (company_id, dedup_key). If an open/acknowledged alert
 * already exists, bumps `count` and `last_seen_at`; otherwise inserts a
 * fresh open alert. `root_cause` + `suggested_actions` are only written
 * on insert and on explicit `updateAlertSummary` calls — sweeps that
 * already have a fresh summary skip the LLM cost.
 */
export async function upsertAlert(input: UpsertAlertInput): Promise<AlertRow> {
  const result = await query<AlertRow>(
    `
      INSERT INTO alerts (
        company_id, kind, severity, entity_type, entity_id,
        count, title, root_cause, suggested_actions,
        dedup_key, metadata
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9::jsonb,
        $10, $11::jsonb
      )
      ON CONFLICT (company_id, dedup_key) WHERE status IN ('open', 'acknowledged')
      DO UPDATE SET
        count = alerts.count + EXCLUDED.count,
        last_seen_at = now(),
        severity = CASE
          WHEN array_position(ARRAY['info','warn','critical'], EXCLUDED.severity)
             > array_position(ARRAY['info','warn','critical'], alerts.severity)
          THEN EXCLUDED.severity
          ELSE alerts.severity
        END,
        title = EXCLUDED.title,
        metadata = alerts.metadata || EXCLUDED.metadata
      RETURNING *
    `,
    [
      input.companyId,
      input.kind,
      input.severity,
      input.entityType ?? null,
      input.entityId ?? null,
      input.incrementBy ?? 1,
      input.title,
      input.rootCause ?? null,
      JSON.stringify(input.suggestedActions ?? []),
      input.dedupKey,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

export async function updateAlertSummary(input: {
  alertId: string;
  rootCause: string;
  suggestedActions: AlertSuggestedAction[];
}): Promise<AlertRow | null> {
  const result = await query<AlertRow>(
    `UPDATE alerts SET root_cause = $2, suggested_actions = $3::jsonb
       WHERE id = $1
       RETURNING *`,
    [input.alertId, input.rootCause, JSON.stringify(input.suggestedActions)],
  );
  return result.rows[0] ?? null;
}

export interface ListAlertsFilter {
  companyId: string;
  status?: AlertStatus | AlertStatus[];
  severity?: AlertSeverity | AlertSeverity[];
  entityType?: string;
  entityId?: string;
  sinceHours?: number;
  limit?: number;
  offset?: number;
}

export async function listAlerts(filter: ListAlertsFilter): Promise<AlertRow[]> {
  const conds: string[] = ["company_id = $1"];
  const params: unknown[] = [filter.companyId];

  if (filter.status) {
    const arr = Array.isArray(filter.status) ? filter.status : [filter.status];
    conds.push(`status = ANY($${params.length + 1}::text[])`);
    params.push(arr);
  }
  if (filter.severity) {
    const arr = Array.isArray(filter.severity)
      ? filter.severity
      : [filter.severity];
    conds.push(`severity = ANY($${params.length + 1}::text[])`);
    params.push(arr);
  }
  if (filter.entityType) {
    conds.push(`entity_type = $${params.length + 1}`);
    params.push(filter.entityType);
  }
  if (filter.entityId) {
    conds.push(`entity_id = $${params.length + 1}`);
    params.push(filter.entityId);
  }
  if (typeof filter.sinceHours === "number" && filter.sinceHours > 0) {
    conds.push(`last_seen_at >= now() - ($${params.length + 1} || ' hours')::interval`);
    params.push(String(filter.sinceHours));
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  params.push(limit);
  params.push(offset);

  const result = await query<AlertRow>(
    `
      SELECT *
      FROM alerts
      WHERE ${conds.join(" AND ")}
      ORDER BY
        CASE severity
          WHEN 'critical' THEN 0
          WHEN 'warn' THEN 1
          ELSE 2
        END,
        last_seen_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
    `,
    params,
  );
  return result.rows;
}

export async function getAlertById(
  companyId: string,
  id: string,
): Promise<AlertRow | null> {
  const result = await query<AlertRow>(
    `SELECT * FROM alerts WHERE company_id = $1 AND id = $2 LIMIT 1`,
    [companyId, id],
  );
  return result.rows[0] ?? null;
}

export async function setAlertStatus(input: {
  companyId: string;
  id: string;
  status: Exclude<AlertStatus, "open">;
  reviewedBy?: string;
  snoozedUntil?: string | null;
}): Promise<AlertRow | null> {
  const ackBy = input.status === "acknowledged" ? input.reviewedBy ?? null : null;
  const ackAt = input.status === "acknowledged" ? "now()" : "NULL";
  const resolvedAt = input.status === "resolved" ? "now()" : "NULL";
  const snoozedUntil = input.status === "snoozed" ? input.snoozedUntil ?? null : null;

  const result = await query<AlertRow>(
    `UPDATE alerts SET
        status = $3,
        acknowledged_by = COALESCE($4, acknowledged_by),
        acknowledged_at = CASE WHEN $3 = 'acknowledged' THEN ${ackAt} ELSE acknowledged_at END,
        resolved_at = CASE WHEN $3 = 'resolved' THEN ${resolvedAt} ELSE resolved_at END,
        snoozed_until = $5
      WHERE company_id = $1 AND id = $2
      RETURNING *`,
    [
      input.companyId,
      input.id,
      input.status,
      ackBy,
      snoozedUntil,
    ],
  );
  return result.rows[0] ?? null;
}

/**
 * Auto-resolve any open or acknowledged alert whose `last_seen_at` is
 * older than `quietHours`. Called from the sweep — keeps the queue
 * clean without a separate cron job.
 */
export async function autoResolveQuietAlerts(quietHours = 6): Promise<number> {
  const result = await query(
    `UPDATE alerts SET status = 'resolved', resolved_at = now()
       WHERE status IN ('open', 'acknowledged')
         AND last_seen_at < now() - ($1 || ' hours')::interval
     RETURNING id`,
    [String(quietHours)],
  );
  return result.rowCount ?? 0;
}

/** Open + snoozed-but-expired counts per severity, for the topbar badge. */
export async function countOpenAlertsBySeverity(
  companyId: string,
): Promise<Record<AlertSeverity, number>> {
  const result = await query<{ severity: AlertSeverity; count: string }>(
    `SELECT severity, COUNT(*)::text AS count
       FROM alerts
       WHERE company_id = $1
         AND (
           status = 'open' OR status = 'acknowledged'
           OR (status = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= now())
         )
       GROUP BY severity`,
    [companyId],
  );
  const out: Record<AlertSeverity, number> = { info: 0, warn: 0, critical: 0 };
  for (const row of result.rows) {
    out[row.severity] = Number(row.count);
  }
  return out;
}
