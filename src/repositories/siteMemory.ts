import { query } from "../db";

// Phase Q1 — aggregated browser-automation knowledge per domain.
// One row per (company_id, domain). `knowledge_json` is the distilled JSON
// produced by services/siteMemoryDistiller.ts from every reviewed playbook
// of that company on the domain.

export interface SiteMemoryRow {
  company_id: string;
  domain: string;
  knowledge_json: SiteKnowledge;
  source_playbook_count: number;
  source_playbook_ids: string[];
  updated_at: string;
}

/**
 * Shape of the distilled knowledge stored in site_memory.knowledge_json.
 * Kept minimal but expressive — Worker prompts read this directly so big bags
 * of fields would just balloon the token budget without helping it act.
 */
export interface SiteKnowledge {
  /** Per-URL summaries, keyed by pathname pattern (e.g. "/MainPage.aspx"). */
  pages: Array<{
    url_pattern: string;
    role: "login" | "dashboard" | "form" | "list" | "confirmation" | "other";
    common_clicks: Array<{ target: string; leads_to_url_pattern: string | null; seen: number }>;
    field_labels: string[];
  }>;
  /** Edges in the navigation graph: from URL → click → to URL. */
  transitions: Array<{
    from_url_pattern: string;
    click_target: string;
    to_url_pattern: string;
    seen: number;
  }>;
  /** Modal/popup patterns we've observed (e.g. "OK confirmation"). */
  dialogs: Array<{ trigger_url: string; button_label: string; seen: number }>;
  /** Field-map shorthand: variable → Georgian form label. */
  field_map: Record<string, string>;
}

const EMPTY_KNOWLEDGE: SiteKnowledge = {
  pages: [],
  transitions: [],
  dialogs: [],
  field_map: {},
};

export async function getSiteMemory(
  companyId: string,
  domain: string,
): Promise<SiteMemoryRow | null> {
  const normalized = normalizeDomain(domain);
  if (!normalized) return null;
  const result = await query<SiteMemoryRow>(
    `SELECT company_id, domain, knowledge_json, source_playbook_count, source_playbook_ids, updated_at
       FROM site_memory
      WHERE company_id = $1 AND domain = $2`,
    [companyId, normalized],
  );
  return result.rows[0] ?? null;
}

export async function upsertSiteMemory(input: {
  companyId: string;
  domain: string;
  knowledge_json: SiteKnowledge;
  source_playbook_ids: string[];
}): Promise<SiteMemoryRow> {
  const normalized = normalizeDomain(input.domain);
  if (!normalized) {
    throw new Error("upsertSiteMemory: empty domain");
  }
  const result = await query<SiteMemoryRow>(
    `INSERT INTO site_memory (company_id, domain, knowledge_json, source_playbook_count, source_playbook_ids, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (company_id, domain) DO UPDATE
       SET knowledge_json = EXCLUDED.knowledge_json,
           source_playbook_count = EXCLUDED.source_playbook_count,
           source_playbook_ids = EXCLUDED.source_playbook_ids,
           updated_at = NOW()
     RETURNING company_id, domain, knowledge_json, source_playbook_count, source_playbook_ids, updated_at`,
    [
      input.companyId,
      normalized,
      input.knowledge_json,
      input.source_playbook_ids.length,
      input.source_playbook_ids,
    ],
  );
  return result.rows[0];
}

export async function listSiteMemoryDomains(
  companyId: string,
): Promise<Array<{ domain: string; updated_at: string; source_playbook_count: number }>> {
  const result = await query<{ domain: string; updated_at: string; source_playbook_count: number }>(
    `SELECT domain, updated_at, source_playbook_count
       FROM site_memory
      WHERE company_id = $1
      ORDER BY updated_at DESC`,
    [companyId],
  );
  return result.rows;
}

export function emptyKnowledge(): SiteKnowledge {
  return JSON.parse(JSON.stringify(EMPTY_KNOWLEDGE));
}

/** Reduce a URL or domain to lowercase host with no protocol/path/port. */
export function normalizeDomain(value: string | null | undefined): string {
  if (!value) return "";
  let raw = String(value).trim().toLowerCase();
  if (!raw) return "";
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      raw = new URL(raw).hostname;
    }
  } catch {
    /* fallthrough — treat as bare host */
  }
  return raw.split("/")[0].split(":")[0].trim();
}
