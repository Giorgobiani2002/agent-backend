import "dotenv/config";
import path from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

// Best-effort fetcher for PUBLIC Georgian legislation from matsne.gov.ge.
// Reads a manifest of sources and writes clean text/PDF into data/legal/, which
// `npm run corpus:ingest` then embeds. This is ACQUISITION only — kept separate
// from ingestion so a blocked download never corrupts the knowledge base.
//
// matsne pages can be JS-rendered; when an HTML fetch yields too little text the
// script tells you to use the source's "PDF" link (set `pdfUrl` in the manifest,
// or download manually) and drop the file into data/legal/.

interface ManifestEntry {
  slug: string;
  title: string;
  topic?: string;
  url?: string; // human/consolidated-text page
  pdfUrl?: string; // direct PDF download (preferred when available)
  version?: string;
  effectiveDate?: string;
  sourceUrl?: string; // canonical citation URL (defaults to url)
}

function legalDir(): string {
  return path.resolve(process.cwd(), "data", "legal");
}

function manifestPath(): string {
  const fromArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  return fromArg ? path.resolve(fromArg) : path.join(legalDir(), "matsne-manifest.json");
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|tr|li|h[1-6]|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";

async function fetchEntry(entry: ManifestEntry, dir: string): Promise<string> {
  // 1) Prefer a direct PDF — pdf-parse handles it during ingestion.
  if (entry.pdfUrl) {
    const res = await fetch(entry.pdfUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`PDF HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const out = path.join(dir, `${entry.slug}.pdf`);
    await writeFile(out, buf);
    return `pdf ${path.basename(out)} (${Math.round(buf.length / 1024)} KB)`;
  }

  // 2) Otherwise fetch the page and strip to text.
  if (!entry.url) throw new Error("entry has neither url nor pdfUrl");
  const res = await fetch(entry.url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = htmlToText(await res.text());

  if (text.length < 1200) {
    throw new Error(
      `only ${text.length} chars extracted (page is likely JS-rendered) — add a "pdfUrl" to the manifest or save the PDF manually into data/legal/${entry.slug}.pdf`,
    );
  }

  const frontmatter = [
    "---",
    `title: ${entry.title}`,
    `topic: ${entry.topic ?? "tax_law"}`,
    `sourceUrl: ${entry.sourceUrl ?? entry.url}`,
    ...(entry.version ? [`version: ${entry.version}`] : []),
    ...(entry.effectiveDate ? [`effectiveDate: ${entry.effectiveDate}`] : []),
    "---",
    "",
  ].join("\n");

  const out = path.join(dir, `${entry.slug}.md`);
  await writeFile(out, `${frontmatter}# ${entry.title}\n\n${text}\n`, "utf8");
  return `md ${path.basename(out)} (${Math.round(text.length / 1024)} KB)`;
}

async function main(): Promise<void> {
  const dir = legalDir();
  await mkdir(dir, { recursive: true });

  const mf = manifestPath();
  const entries = JSON.parse(await readFile(mf, "utf8")) as ManifestEntry[];
  console.log(`Fetching ${entries.length} source(s) → ${dir}`);

  let ok = 0;
  let failed = 0;
  for (const entry of entries) {
    try {
      const summary = await fetchEntry(entry, dir);
      console.log(`  ok   ${entry.slug}: ${summary}`);
      ok += 1;
    } catch (error) {
      console.error(`  fail ${entry.slug}: ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }
  }

  console.log(JSON.stringify({ total: entries.length, ok, failed }, null, 2));
  if (ok === 0 && entries.length > 0) {
    console.log(
      "\nNo sources fetched automatically. Save each law's PDF from matsne.gov.ge into data/legal/, then run: npm run corpus:ingest",
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
