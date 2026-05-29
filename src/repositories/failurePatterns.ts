import { query } from "../db";
import { normalizeDomain } from "./siteMemory";

// Phase Q2 — closed-loop failure learning. Every K1/M1/K4/postcondition fail
// in the Python agent POSTs to /agent/failure-patterns; on dedup-collision
// we bump occurrence_count instead of inserting a new row. Future runs in
// the same (company, domain) pull the top patterns and inject them into the
// Worker prompt as "WATCH OUT FOR ..." hints.

export type FailureType =
  | "k1_hallucination"
  | "m1_zero_field"
  | "m1_not_confirmation"
  | "k4_url"
  | "postcondition"
  | "manual";

export const FAILURE_TYPES: FailureType[] = [
  "k1_hallucination",
  "m1_zero_field",
  "m1_not_confirmation",
  "k4_url",
  "postcondition",
  "manual",
];

export function isFailureType(value: unknown): value is FailureType {
  return typeof value === "string" && FAILURE_TYPES.includes(value as FailureType);
}

export interface FailurePatternRow {
  id: string;
  company_id: string;
  domain: string;
  url_pattern: string | null;
  field_label: string | null;
  failure_type: FailureType;
  symptom: string;
  workaround: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface RecordFailureInput {
  companyId: string;
  domain: string;
  url_pattern?: string | null;
  field_label?: string | null;
  failure_type: FailureType;
  symptom: string;
  workaround?: string | null;
}

/**
 * Record a failure pattern. On dedup-collision (same company + domain + url
 * + label + type), we bump occurrence_count and refresh last_seen_at;
 * otherwise we insert a new row. Returns the resulting row in either case.
 */
export async function recordFailurePattern(input: RecordFailureInput): Promise<FailurePatternRow> {
  const domain = normalizeDomain(input.domain);
  if (!domain) {
    throw new Error("recordFailurePattern: domain required");
  }
  const result = await query<FailurePatternRow>(
    `INSERT INTO agent_failure_patterns (
        company_id, domain, url_pattern, field_label, failure_type, symptom, workaround
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, domain, COALESCE(url_pattern, ''), COALESCE(field_label, ''), failure_type)
     DO UPDATE SET
        occurrence_count = agent_failure_patterns.occurrence_count + 1,
        last_seen_at = NOW(),
        symptom = EXCLUDED.symptom,
        workaround = COALESCE(EXCLUDED.workaround, agent_failure_patterns.workaround)
     RETURNING id, company_id, domain, url_pattern, field_label, failure_type, symptom,
               workaround, occurrence_count, first_seen_at, last_seen_at`,
    [
      input.companyId,
      domain,
      input.url_pattern ?? null,
      input.field_label ?? null,
      input.failure_type,
      input.symptom.slice(0, 1000),
      input.workaround?.slice(0, 1000) ?? null,
    ],
  );
  return result.rows[0];
}

export async function listFailurePatterns(
  companyId: string,
  domain: string,
  limit = 30,
): Promise<FailurePatternRow[]> {
  const normalized = normalizeDomain(domain);
  if (!normalized) return [];
  const result = await query<FailurePatternRow>(
    `SELECT id, company_id, domain, url_pattern, field_label, failure_type, symptom,
            workaround, occurrence_count, first_seen_at, last_seen_at
       FROM agent_failure_patterns
      WHERE company_id = $1 AND domain = $2
      ORDER BY occurrence_count DESC, last_seen_at DESC
      LIMIT $3`,
    [companyId, normalized, limit],
  );
  return result.rows;
}
