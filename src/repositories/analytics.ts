import { query } from "../db";

export interface PlaybookAnalyticsRow {
  playbook_id: string;
  playbook_name: string;
  total_runs: number;
  success_count: number;
  failed_count: number;
  success_rate: number;          // 0..1, NaN-safe (0 when no runs)
  avg_steps_taken: number | null;
  avg_duration_sec: number | null;
  cache_record_count: number;    // how many times a fresh cache was saved (AI runs)
  cache_success_count: number;   // how many times replay succeeded (free runs)
  cache_hit_rate: number;        // success / (success + recorded), 0 when no data
  est_cost_saved_usd: number;    // success * approx-per-AI-run cost
}

export interface AnalyticsSummary {
  total_bulk_runs: number;
  total_rows_processed: number;
  total_success: number;
  total_failed: number;
  overall_success_rate: number;
  total_cache_hits: number;
  total_cache_records: number;
  total_est_cost_saved_usd: number;
}

// Approx per-AI-run cost — gemini-3.1-flash-lite worker for ~40 steps + a few
// gemini-3.1-pro planner calls. Used purely for the "saved by cache" headline.
const APPROX_AI_RUN_USD = Number(process.env.APPROX_AI_RUN_USD ?? "0.10");

export async function getPlaybookAnalytics(
  companyId: string,
  days?: number,
): Promise<PlaybookAnalyticsRow[]> {
  // $1=cost, $2=companyId, [$3=days]
  const dateFilter = days ? `AND r.finished_at > NOW() - ($3 * INTERVAL '1 day')` : "";
  const params: unknown[] = [APPROX_AI_RUN_USD, companyId];
  if (days) params.push(days);

  const result = await query<PlaybookAnalyticsRow>(
    `
    WITH row_stats AS (
      SELECT
        r.playbook_id,
        COUNT(*)::int AS total_runs,
        COUNT(*) FILTER (WHERE r.status = 'success')::int AS success_count,
        COUNT(*) FILTER (WHERE r.status = 'failed')::int AS failed_count,
        AVG(r.steps_taken) FILTER (WHERE r.steps_taken IS NOT NULL) AS avg_steps_taken,
        AVG(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)))
          FILTER (WHERE r.finished_at IS NOT NULL AND r.started_at IS NOT NULL)
          AS avg_duration_sec
      FROM bulk_run_rows r
      JOIN bulk_runs br ON br.id = r.run_id
      WHERE r.playbook_id IS NOT NULL
        AND br.company_id = $2
        ${dateFilter}
      GROUP BY r.playbook_id
    ),
    cache_stats AS (
      SELECT
        pac.playbook_id,
        SUM(pac.recorded_count)::int AS cache_record_count,
        SUM(pac.success_count)::int AS cache_success_count
      FROM playbook_action_cache pac
      JOIN playbooks p ON p.id = pac.playbook_id
      WHERE p.company_id = $2
      GROUP BY pac.playbook_id
    )
    SELECT
      p.id AS playbook_id,
      p.name AS playbook_name,
      COALESCE(rs.total_runs, 0) AS total_runs,
      COALESCE(rs.success_count, 0) AS success_count,
      COALESCE(rs.failed_count, 0) AS failed_count,
      CASE
        WHEN COALESCE(rs.total_runs, 0) = 0 THEN 0
        ELSE COALESCE(rs.success_count, 0)::float / rs.total_runs
      END AS success_rate,
      rs.avg_steps_taken,
      rs.avg_duration_sec,
      COALESCE(cs.cache_record_count, 0) AS cache_record_count,
      COALESCE(cs.cache_success_count, 0) AS cache_success_count,
      CASE
        WHEN COALESCE(cs.cache_record_count, 0) + COALESCE(cs.cache_success_count, 0) = 0 THEN 0
        ELSE COALESCE(cs.cache_success_count, 0)::float
             / (COALESCE(cs.cache_record_count, 0) + COALESCE(cs.cache_success_count, 0))
      END AS cache_hit_rate,
      COALESCE(cs.cache_success_count, 0) * $1::float AS est_cost_saved_usd
    FROM playbooks p
    LEFT JOIN row_stats rs ON rs.playbook_id = p.id
    LEFT JOIN cache_stats cs ON cs.playbook_id = p.id
    WHERE p.status = 'ready' AND p.company_id = $2
    ORDER BY COALESCE(rs.total_runs, 0) DESC, p.created_at DESC
    `,
    params,
  );
  return result.rows;
}

export async function getAnalyticsSummary(
  companyId: string,
  days?: number,
): Promise<AnalyticsSummary> {
  // $1=cost, $2=companyId, [$3=days]
  const rowsDateFilter = days ? `AND br.finished_at > NOW() - ($3 * INTERVAL '1 day')` : "";
  const bulkDateFilter = days ? `AND created_at > NOW() - ($3 * INTERVAL '1 day')` : "";
  const params: unknown[] = [APPROX_AI_RUN_USD, companyId];
  if (days) params.push(days);

  const result = await query<AnalyticsSummary>(
    `
    WITH row_totals AS (
      SELECT
        COUNT(*)::int AS total_rows_processed,
        COUNT(*) FILTER (WHERE r.status = 'success')::int AS total_success,
        COUNT(*) FILTER (WHERE r.status = 'failed')::int AS total_failed
      FROM bulk_run_rows r
      JOIN bulk_runs br ON br.id = r.run_id
      WHERE br.company_id = $2
        ${rowsDateFilter}
    ),
    bulk_totals AS (
      SELECT COUNT(*)::int AS total_bulk_runs
        FROM bulk_runs
        WHERE company_id = $2
          ${bulkDateFilter}
    ),
    cache_totals AS (
      SELECT
        COALESCE(SUM(pac.success_count), 0)::int AS total_cache_hits,
        COALESCE(SUM(pac.recorded_count), 0)::int AS total_cache_records
      FROM playbook_action_cache pac
      JOIN playbooks p ON p.id = pac.playbook_id
      WHERE p.company_id = $2
    )
    SELECT
      bt.total_bulk_runs,
      rt.total_rows_processed,
      rt.total_success,
      rt.total_failed,
      CASE
        WHEN rt.total_rows_processed = 0 THEN 0
        ELSE rt.total_success::float / rt.total_rows_processed
      END AS overall_success_rate,
      ct.total_cache_hits,
      ct.total_cache_records,
      ct.total_cache_hits * $1::float AS total_est_cost_saved_usd
    FROM bulk_totals bt, row_totals rt, cache_totals ct
    `,
    params,
  );
  return result.rows[0];
}

export interface DailyTrendRow {
  day: string;
  total: number;
  success: number;
  failed: number;
  rate: number | null;
}

export async function getDailyTrend(companyId: string, days = 7): Promise<DailyTrendRow[]> {
  const result = await query<DailyTrendRow>(
    `
    SELECT
      TO_CHAR(DATE(r.finished_at), 'YYYY-MM-DD') AS day,
      COUNT(*)::int                                                   AS total,
      COUNT(*) FILTER (WHERE r.status = 'success')::int              AS success,
      COUNT(*) FILTER (WHERE r.status = 'failed')::int               AS failed,
      COUNT(*) FILTER (WHERE r.status = 'success')::float
        / NULLIF(COUNT(*), 0)                                         AS rate
    FROM bulk_run_rows r
    JOIN bulk_runs br ON br.id = r.run_id
    WHERE r.finished_at IS NOT NULL
      AND br.company_id = $1
      AND r.finished_at > NOW() - ($2 * INTERVAL '1 day')
    GROUP BY DATE(r.finished_at)
    ORDER BY DATE(r.finished_at) DESC
    `,
    [companyId, days],
  );
  return result.rows;
}

export interface RecentFailureRow {
  id: string;
  row_index: number;
  error: string;
  finished_at: string | null;
  attempt_count: number;
  playbook_name: string | null;
  run_id: string;
}

export async function getRecentFailures(
  companyId: string,
  limit = 20,
): Promise<RecentFailureRow[]> {
  const result = await query<RecentFailureRow>(
    `
    SELECT
      r.id,
      r.row_index,
      r.error,
      r.finished_at,
      r.attempt_count,
      p.name   AS playbook_name,
      br.id    AS run_id
    FROM bulk_run_rows r
    LEFT JOIN playbooks p  ON p.id  = r.playbook_id
    JOIN      bulk_runs  br ON br.id = r.run_id
    WHERE r.status = 'failed'
      AND r.error IS NOT NULL
      AND br.company_id = $1
    ORDER BY r.finished_at DESC NULLS LAST
    LIMIT $2
    `,
    [companyId, limit],
  );
  return result.rows;
}
