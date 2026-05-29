import { listPlaybooks, type PlaybookRow, type PlaybookStep } from "../repositories/playbooks";
import {
  emptyKnowledge,
  normalizeDomain,
  upsertSiteMemory,
  type SiteKnowledge,
} from "../repositories/siteMemory";

// Phase Q1 — turn raw recorded playbook steps into per-domain SiteKnowledge.
//
// We distill ONLY reviewed task playbooks. For each playbook:
//   1. Walk its steps in order.
//   2. Track the "current URL" — initialised from the first NAVIGATE; updated
//      every time we see another NAVIGATE.
//   3. For each click/select before the first TYPE: record (current URL, target,
//      next URL after the click) so we end up with a transition graph.
//   4. For each TYPE step: capture (URL, label, value substitution variable)
//      into per-page field labels + a global field_map.
//
// Run-time complexity is O(steps), and the result is small enough that we
// keep it in a single jsonb column. We don't try to deduplicate across
// recordings beyond merging counts — the Worker prompt will see noise either
// way; what matters is "this label exists on this page".

const VAR_PATTERN = /\$\{([a-zA-Z0-9_]+)\}/g;

function urlPathPattern(url: string | null | undefined): string {
  if (!url) return "";
  try {
    if (/^https?:\/\//i.test(url)) {
      const parsed = new URL(url);
      return parsed.pathname || "/";
    }
  } catch {
    /* fall through */
  }
  // Bare path or non-URL — strip query/hash so equal pages collapse.
  return url.split("#")[0].split("?")[0] || "";
}

function urlDomain(url: string | null | undefined): string {
  if (!url) return "";
  try {
    if (/^https?:\/\//i.test(url)) {
      return normalizeDomain(new URL(url).hostname);
    }
  } catch {
    /* */
  }
  return "";
}

function inferPageRole(steps: PlaybookStep[], indexInPb: number, urlPattern: string): SiteKnowledge["pages"][number]["role"] {
  // Heuristic: the LAST page (where TYPE / dangerous step happens) is "form";
  // the first navigation target is "login" or "dashboard"; everything else
  // we leave as "other" — it's mostly noise for the Worker anyway.
  const path = urlPattern.toLowerCase();
  if (/login|signin|auth/.test(path)) return "login";
  if (/dashboard|main|home|index/.test(path)) return "dashboard";
  if (/edit|form|new|create|declaration/.test(path)) return "form";
  if (/list|search|index/.test(path)) return "list";
  // If a later step on this page is dangerous (submit), it's a form page.
  for (let i = indexInPb; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.dangerous) return "form";
    if (s.action === "type") return "form";
  }
  return "other";
}

interface PageBuilder {
  url_pattern: string;
  role: SiteKnowledge["pages"][number]["role"];
  click_counts: Map<string, { target: string; leads_to: string | null; seen: number }>;
  field_labels: Set<string>;
}

interface TransitionKey {
  from: string;
  click: string;
  to: string;
}

function transitionKey(t: TransitionKey): string {
  return `${t.from}${t.click}${t.to}`;
}

function distillSinglePlaybook(steps: PlaybookStep[]): {
  pages: Map<string, PageBuilder>;
  transitions: Map<string, { from: string; click: string; to: string; seen: number }>;
  dialogs: Map<string, { trigger_url: string; button_label: string; seen: number }>;
  field_map: Record<string, string>;
} {
  const pages = new Map<string, PageBuilder>();
  const transitions = new Map<string, { from: string; click: string; to: string; seen: number }>();
  const dialogs = new Map<string, { trigger_url: string; button_label: string; seen: number }>();
  const fieldMap: Record<string, string> = {};

  let currentUrl = "";

  function getPage(url: string, idx: number): PageBuilder {
    let b = pages.get(url);
    if (!b) {
      b = {
        url_pattern: url,
        role: inferPageRole(steps, idx, url),
        click_counts: new Map(),
        field_labels: new Set(),
      };
      pages.set(url, b);
    }
    return b;
  }

  // First navigate sets the baseline URL.
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i];
    if (s.action === "navigate" && s.url) {
      currentUrl = urlPathPattern(s.url);
      getPage(currentUrl, i);
      continue;
    }
    const target = (s.target_text ?? s.target_description ?? "").trim();
    if (!target) continue;

    if (s.action === "click" || s.action === "select") {
      const url = currentUrl || "(unknown)";
      const page = getPage(url, i);

      // Look ahead to the NEXT navigate (if any) to learn where this click
      // takes us. If the next navigate happens before another click of the
      // same target, that navigation is likely caused by this click.
      let nextUrl: string | null = null;
      for (let j = i + 1; j < steps.length; j += 1) {
        const sj = steps[j];
        if (sj.action === "navigate" && sj.url) {
          nextUrl = urlPathPattern(sj.url);
          break;
        }
        if ((sj.action === "click" || sj.action === "select") && sj !== s) {
          // Another interactable came first → click probably didn't navigate.
          break;
        }
      }

      const existing = page.click_counts.get(target);
      if (existing) {
        existing.seen += 1;
        if (!existing.leads_to && nextUrl) existing.leads_to = nextUrl;
      } else {
        page.click_counts.set(target, { target, leads_to: nextUrl, seen: 1 });
      }

      if (nextUrl && nextUrl !== url) {
        const k = transitionKey({ from: url, click: target, to: nextUrl });
        const prev = transitions.get(k);
        if (prev) prev.seen += 1;
        else transitions.set(k, { from: url, click: target, to: nextUrl, seen: 1 });
      }

      // OK / დიახ / Confirm / Cancel — popup-style buttons.
      if (/\b(ok|დიახ|confirm|დადასტურება|გათიშვა|cancel)\b/i.test(target)) {
        const dk = `${url}${target}`;
        const prev = dialogs.get(dk);
        if (prev) prev.seen += 1;
        else dialogs.set(dk, { trigger_url: url, button_label: target, seen: 1 });
      }
    } else if (s.action === "type") {
      const url = currentUrl || "(unknown)";
      const page = getPage(url, i);
      const label = (s.target_text ?? s.target_description ?? "").trim();
      if (label) page.field_labels.add(label.slice(0, 200));

      // Pull ${var} variables out of the typed value to build the field map.
      const value = s.value ?? "";
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      VAR_PATTERN.lastIndex = 0;
      while ((m = VAR_PATTERN.exec(value)) !== null) {
        const varName = m[1];
        if (seen.has(varName)) continue;
        seen.add(varName);
        if (label && !fieldMap[varName]) fieldMap[varName] = label.slice(0, 200);
      }
    }
  }

  return { pages, transitions, dialogs, field_map: fieldMap };
}

/**
 * Distill ALL reviewed task playbooks for a given domain into one merged
 * SiteKnowledge. Counts accumulate across recordings.
 */
export function buildSiteKnowledge(
  domain: string,
  playbooks: PlaybookRow[],
): { knowledge: SiteKnowledge; sourceIds: string[] } {
  const target = normalizeDomain(domain);
  if (!target) return { knowledge: emptyKnowledge(), sourceIds: [] };

  const aggPages = new Map<string, PageBuilder>();
  const aggTransitions = new Map<string, { from: string; click: string; to: string; seen: number }>();
  const aggDialogs = new Map<string, { trigger_url: string; button_label: string; seen: number }>();
  const aggFieldMap: Record<string, string> = {};
  const sourceIds: string[] = [];

  for (const pb of playbooks) {
    if (pb.kind !== "task") continue;
    if (pb.review_status !== "reviewed") continue;
    if (!Array.isArray(pb.steps) || pb.steps.length === 0) continue;

    // Match the playbook to this domain by inspecting its navigate steps.
    // If the playbook has at least one navigate step, require one to target
    // `target`. If there are NO navigate steps at all (recording started
    // mid-flow on the target site), treat it as matching — the alternative
    // is silently dropping every recording that was captured without an
    // initial navigate.
    const navSteps = pb.steps.filter((s) => s.action === "navigate" && s.url);
    if (navSteps.length > 0) {
      const matchesDomain = navSteps.some((s) => urlDomain(s.url ?? "") === target);
      if (!matchesDomain) continue;
    }

    sourceIds.push(pb.id);
    const distilled = distillSinglePlaybook(pb.steps);

    for (const [url, page] of distilled.pages) {
      const merged = aggPages.get(url) ?? {
        url_pattern: page.url_pattern,
        role: page.role,
        click_counts: new Map<string, { target: string; leads_to: string | null; seen: number }>(),
        field_labels: new Set<string>(),
      };
      // Prefer non-"other" role if any recording inferred a more specific one.
      if (merged.role === "other" && page.role !== "other") merged.role = page.role;
      for (const [target, click] of page.click_counts) {
        const prev = merged.click_counts.get(target);
        if (prev) {
          prev.seen += click.seen;
          if (!prev.leads_to && click.leads_to) prev.leads_to = click.leads_to;
        } else {
          merged.click_counts.set(target, { ...click });
        }
      }
      for (const f of page.field_labels) merged.field_labels.add(f);
      aggPages.set(url, merged);
    }
    for (const [k, t] of distilled.transitions) {
      const prev = aggTransitions.get(k);
      if (prev) prev.seen += t.seen;
      else aggTransitions.set(k, { ...t });
    }
    for (const [k, d] of distilled.dialogs) {
      const prev = aggDialogs.get(k);
      if (prev) prev.seen += d.seen;
      else aggDialogs.set(k, { ...d });
    }
    for (const [k, v] of Object.entries(distilled.field_map)) {
      if (!aggFieldMap[k]) aggFieldMap[k] = v;
    }
  }

  const knowledge: SiteKnowledge = {
    pages: Array.from(aggPages.values()).map((p) => ({
      url_pattern: p.url_pattern,
      role: p.role,
      common_clicks: Array.from(p.click_counts.values())
        .sort((a, b) => b.seen - a.seen)
        .slice(0, 30)
        .map((c) => ({ target: c.target, leads_to_url_pattern: c.leads_to, seen: c.seen })),
      field_labels: Array.from(p.field_labels).slice(0, 50),
    })),
    transitions: Array.from(aggTransitions.values())
      .sort((a, b) => b.seen - a.seen)
      .slice(0, 50)
      .map((t) => ({ from_url_pattern: t.from, click_target: t.click, to_url_pattern: t.to, seen: t.seen })),
    dialogs: Array.from(aggDialogs.values())
      .sort((a, b) => b.seen - a.seen)
      .slice(0, 20),
    field_map: aggFieldMap,
  };

  return { knowledge, sourceIds };
}

/**
 * Convenience: rebuild and persist site_memory for a domain by pulling the
 * latest set of reviewed playbooks. Called when a playbook is reviewed
 * (or rejected, in case the reviewer wants to remove a bad recording).
 */
export async function rebuildSiteMemoryFor(
  companyId: string,
  domain: string,
): Promise<{ domain: string; sourcePlaybookCount: number }> {
  const target = normalizeDomain(domain);
  if (!target) return { domain: "", sourcePlaybookCount: 0 };

  const all = await listPlaybooks(companyId);
  const { knowledge, sourceIds } = buildSiteKnowledge(target, all);
  await upsertSiteMemory({
    companyId,
    domain: target,
    knowledge_json: knowledge,
    source_playbook_ids: sourceIds,
  });
  return { domain: target, sourcePlaybookCount: sourceIds.length };
}

/**
 * After a playbook review/reject, figure out which domains it touches and
 * rebuild memory for each. A single playbook usually touches one domain.
 */
export async function rebuildSiteMemoryForPlaybook(playbook: PlaybookRow): Promise<string[]> {
  const domains = new Set<string>();
  for (const step of playbook.steps ?? []) {
    if (step.action === "navigate" && step.url) {
      const d = urlDomain(step.url);
      if (d) domains.add(d);
    }
  }
  // Fallback when the recording started mid-flow with no NAVIGATE step:
  // refresh memory for every domain this company already tracks (so the
  // playbook contributes wherever it might apply). First-time recordings on a
  // fresh DB still leave memory empty; the user can rebuild manually via the
  // bootstrap endpoint.
  if (domains.size === 0) {
    const existing = await import("../repositories/siteMemory")
      .then((m) => m.listSiteMemoryDomains(playbook.company_id));
    for (const row of existing) domains.add(row.domain);
  }
  for (const d of domains) {
    try {
      await rebuildSiteMemoryFor(playbook.company_id, d);
    } catch (err) {
      // Distillation failures are non-fatal — playbook can still be reviewed.
      console.error(`[siteMemoryDistiller] rebuildSiteMemoryFor(${d}) failed:`, err);
    }
  }
  return Array.from(domains);
}
