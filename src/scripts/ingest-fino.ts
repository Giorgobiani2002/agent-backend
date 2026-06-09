import "dotenv/config";
import path from "path";
import { readFile } from "fs/promises";
import { db, initializePgVector } from "../db";
import { ingestBook } from "../services/books";
import { corpusMetadata } from "../services/corpus-ingest";
import { findBookBySourcePath } from "../repositories/books";

// Ingests templates/fino-library.json (234 Georgian business-document templates,
// parsed from Google Docs/Sheets) into the global knowledge base so the chat can
// reference real primary-document structures. Each template becomes one book.

interface FinoBlock {
  type: "p" | "table" | string;
  text?: string;
  rows?: unknown[];
}

interface FinoDoc {
  id: string;
  category?: string;
  category_label?: string;
  title: string;
  kind?: string;
  body?: FinoBlock[];
}

function flattenRow(row: unknown): string {
  if (Array.isArray(row)) return row.map((cell) => String(cell ?? "").trim()).join(" | ");
  return String(row ?? "").trim();
}

function flattenBody(body: FinoBlock[] = []): string {
  return body
    .map((block) => {
      if (block.type === "table") return (block.rows ?? []).map(flattenRow).filter(Boolean).join("\n");
      return (block.text ?? "").trim();
    })
    .filter(Boolean)
    .join("\n\n");
}

function libraryPath(): string {
  const fromArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  if (fromArg) return path.resolve(fromArg);
  return path.resolve(process.cwd(), "..", "templates", "fino-library.json");
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const file = libraryPath();
  const raw = await readFile(file, "utf8");
  const docs = JSON.parse(raw) as FinoDoc[];

  if (!Array.isArray(docs)) throw new Error("fino-library.json must be an array");

  await initializePgVector();
  console.log(`Found ${docs.length} FINO template(s) in ${file}`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const doc of docs) {
    const sourcePath = `fino:${doc.id}`;
    const title = (doc.title || "").trim() || `FINO ${doc.id}`;
    try {
      const existing = await findBookBySourcePath(sourcePath);
      if (existing && !force) {
        skipped += 1;
        continue;
      }

      const text = flattenBody(doc.body);
      if (!text) {
        skipped += 1;
        continue;
      }

      const meta = corpusMetadata({
        topic: "fino_template",
        language: "ka",
        source: "fino",
        sourcePath,
        corpusId: "fino-library",
        extra: {
          finoId: doc.id,
          category: doc.category,
          categoryLabel: doc.category_label,
          kind: doc.kind,
        },
      });

      await ingestBook({ title, text, allowLarge: true, metadata: meta, chunkMetadata: meta });
      imported += 1;
      if (imported % 25 === 0) console.log(`  ...${imported} ingested`);
    } catch (error) {
      failed += 1;
      console.error(`  fail ${title}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(JSON.stringify({ file, total: docs.length, imported, skipped, failed }, null, 2));
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
