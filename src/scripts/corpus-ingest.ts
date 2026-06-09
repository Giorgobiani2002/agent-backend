import "dotenv/config";
import path from "path";
import { db, initializePgVector } from "../db";
import {
  ingestCorpusFolder,
  summarize,
  type CorpusFolderInput,
  type CorpusIngestResult,
} from "../services/corpus-ingest";

// Single idempotent command that ingests every drop-folder + repo corpus into
// the global knowledge base. FINO templates have their own shape — run
// `npm run fino:ingest` separately. Re-running skips already-ingested files
// unless --force is passed.

const FOLDERS: CorpusFolderInput[] = [
  { directory: "data/legal", topic: "tax_law", language: "ka" },
  { directory: "data/rs-manuals", topic: "rs_manual", language: "ka" },
  { directory: "data/accounting", topic: "accounting_book", language: "en" },
  { directory: "data/ge-tax-ai-corpus", topic: "reference", language: "ka" },
];

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  await initializePgVector();

  const all: CorpusIngestResult[] = [];
  for (const folder of FOLDERS) {
    const dir = path.resolve(process.cwd(), folder.directory);
    console.log(`\n▸ ${folder.directory} (topic=${folder.topic})`);
    const results = await ingestCorpusFolder({ ...folder, directory: dir, force });
    for (const r of results) {
      const tag = r.error ? "fail" : r.skipped ? "skip" : "ok  ";
      console.log(`  ${tag} ${r.sourcePath}${r.error ? `: ${r.error}` : ""}`);
    }
    all.push(...results);
  }

  console.log("\n" + JSON.stringify(summarize(all), null, 2));
  if (all.some((r) => r.error)) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
