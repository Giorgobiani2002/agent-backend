import { createHash } from "crypto";
import { query } from "../db";
import type { PlaybookStep } from "./playbooks";
import type { ExecutionCompletionState, SafetyMode } from "../types/execution";

/**
 * One step in a cached run. Captured from browser-use's AgentHistoryList — see
 * agent/main.py history dump. Replay code uses x_path first, then ax_name as
 * a fallback for matching elements when xpath drifts (e.g. SPA re-renders).
 */
export interface CachedAction {
  index: number;
  /** Type of action: navigate, click, input_text, scroll_down, send_keys, ... */
  action: string;
  /** Target XPath captured at record time (most precise selector). */
  x_path?: string | null;
  /** Accessibility name (visible text) — used as fallback when xpath fails. */
  ax_name?: string | null;
  /** Tag name (input, button, a, ...). */
  node_name?: string | null;
  /** Filtered DOM attributes (id, class, name, role, type, ...). */
  attributes?: Record<string, string> | null;
  /**
   * For input_text: the text typed. May contain ${variable} placeholders that
   * the replay layer will substitute from the run's data dictionary.
   */
  value_template?: string | null;
  /** For navigate / go_to_url: target URL. */
  url?: string | null;
  /** Original playbook step index this action corresponds to (best-effort). */
  playbook_step_index?: number | null;
}

export interface PlaybookCacheRow {
  id: string;
  playbook_id: string;
  playbook_version: string;
  actions: CachedAction[];
  safety_mode: SafetyMode;
  completion_state: ExecutionCompletionState;
  postconditions: Record<string, unknown>;
  success_count: number;
  recorded_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Stable hash of the playbook's steps. Cache invalidates if steps change. */
export function computePlaybookVersion(steps: PlaybookStep[]): string {
  // Strip timestamps (which change between recordings of the same flow) and
  // hash the meaningful structural fields only.
  const canonical = steps.map((s) => ({
    action: s.action,
    target_description: s.target_description ?? "",
    target_text: s.target_text ?? "",
    value: s.value ?? "",
    url: s.url ?? "",
    wait_ms: s.wait_ms ?? 0,
  }));
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex")
    .slice(0, 16);
}

export async function findCacheByPlaybook(
  playbookId: string,
  playbookVersion: string,
): Promise<PlaybookCacheRow | null> {
  const result = await query<PlaybookCacheRow>(
    `SELECT * FROM playbook_action_cache
     WHERE playbook_id = $1 AND playbook_version = $2`,
    [playbookId, playbookVersion],
  );
  return result.rows[0] ?? null;
}

export interface CacheSummary {
  playbook_id: string;
  action_count: number;
  success_count: number;
  recorded_count: number;
  updated_at: string;
  safety_mode: SafetyMode;
  completion_state: ExecutionCompletionState;
}

/**
 * Returns the most-recently-updated cache row per playbook (one row per playbook
 * even if multiple versions exist). Used by the playbooks list page to show
 * a badge on each card. Scoped to the calling company via a JOIN on playbooks.
 */
export async function listLatestCachesByPlaybook(companyId: string): Promise<CacheSummary[]> {
  const result = await query<CacheSummary>(
    `SELECT DISTINCT ON (pac.playbook_id)
       pac.playbook_id,
       jsonb_array_length(pac.actions) AS action_count,
       pac.success_count,
       pac.recorded_count,
       pac.updated_at,
       pac.safety_mode,
       pac.completion_state
     FROM playbook_action_cache pac
     JOIN playbooks p ON p.id = pac.playbook_id
     WHERE p.company_id = $1
     ORDER BY pac.playbook_id, pac.updated_at DESC`,
    [companyId],
  );
  return result.rows;
}

export async function listCachesForPlaybook(
  playbookId: string,
): Promise<PlaybookCacheRow[]> {
  const result = await query<PlaybookCacheRow>(
    `SELECT * FROM playbook_action_cache
     WHERE playbook_id = $1
     ORDER BY updated_at DESC`,
    [playbookId],
  );
  return result.rows;
}

/**
 * Upsert: if a cache for (playbook_id, playbook_version) exists, overwrite
 * its actions and bump recorded_count. Otherwise insert a new row.
 */
export async function upsertCache(input: {
  playbookId: string;
  playbookVersion: string;
  actions: CachedAction[];
  safetyMode: SafetyMode;
  completionState: ExecutionCompletionState;
  postconditions?: Record<string, unknown>;
}): Promise<PlaybookCacheRow> {
  const result = await query<PlaybookCacheRow>(
    `INSERT INTO playbook_action_cache (
       playbook_id, playbook_version, actions, safety_mode, completion_state, postconditions, recorded_count
     )
     VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, 1)
     ON CONFLICT (playbook_id, playbook_version)
     DO UPDATE SET
       actions = EXCLUDED.actions,
       safety_mode = EXCLUDED.safety_mode,
       completion_state = EXCLUDED.completion_state,
       postconditions = EXCLUDED.postconditions,
       recorded_count = playbook_action_cache.recorded_count + 1,
       updated_at = now()
     RETURNING *`,
    [
      input.playbookId,
      input.playbookVersion,
      JSON.stringify(input.actions),
      input.safetyMode,
      input.completionState,
      JSON.stringify(input.postconditions ?? {}),
    ],
  );
  return result.rows[0];
}

export async function recordCacheHit(
  cacheId: string,
  completionState?: ExecutionCompletionState,
): Promise<void> {
  await query(
    `UPDATE playbook_action_cache
     SET success_count = success_count + 1,
         last_used_at = now(),
         completion_state = COALESCE($2, completion_state)
     WHERE id = $1`,
    [cacheId, completionState ?? null],
  );
}

export async function deleteCachesForPlaybook(playbookId: string): Promise<number> {
  const result = await query(
    `DELETE FROM playbook_action_cache WHERE playbook_id = $1`,
    [playbookId],
  );
  return result.rowCount ?? 0;
}
