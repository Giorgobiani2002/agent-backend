import "dotenv/config";
import path from "path";
import { readdir, readFile, stat } from "fs/promises";
import { db, initializePgVector } from "../db";
import { ingestBook } from "../services/books";
import { findBookBySourcePath } from "../repositories/books";

// Companion to ingest-data.ts (which handles PDFs). This script ingests
// .md/.txt knowledge files from the same data/ tree. Markdown is what
// Claude produces when distilling source material, so we treat each file
// as one global "book" in the shared accounting brain.

async function discoverTextFiles(directory: string): Promise<string[]> {
  const root = path.resolve(directory);
  const rootStat = await stat(root);
  if (!rootStat.isDirectory()) {
    throw new Error(`Markdown data path is not a directory: ${root}`);
  }

  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (
        entry.isFile() &&
        (entry.name.toLowerCase().endsWith(".md") ||
          entry.name.toLowerCase().endsWith(".txt"))
      ) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files;
}

function defaultDataDirectory(): string {
  return path.resolve(process.cwd(), "data");
}

function titleFromPath(filePath: string): string {
  return path
    .basename(filePath)
    .replace(/\.(md|txt)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function printHelp(): void {
  console.log(`Usage: npm run knowledge:ingest-md -- [directory] [--force]

Ingests .md / .txt files into the GLOBAL accounting/finance knowledge base.
Each file becomes one book; embeddings are chunked normally.

Options:
  directory   PDF/markdown root (default: ./data)
  --force     Re-ingest even when metadata.sourcePath already exists
  --help      Show this help text`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const force = args.includes("--force");
  const directoryArg = args.find((arg) => !arg.startsWith("--"));
  const directory = directoryArg ? path.resolve(directoryArg) : defaultDataDirectory();

  await initializePgVector();

  const files = await discoverTextFiles(directory);
  console.log(`Found ${files.length} markdown/text file(s) under ${directory}`);

  let imported = 0;
  let skipped = 0;
  let failed = 0;

  for (const filePath of files) {
    const sourcePath = filePath;
    try {
      const existing = await findBookBySourcePath(sourcePath);
      if (existing && !force) {
        console.log(`  skip  ${path.relative(directory, filePath)} (already ingested)`);
        skipped += 1;
        continue;
      }

      const text = await readFile(filePath, "utf8");
      const title = titleFromPath(filePath);
      await ingestBook({
        title,
        text,
        metadata: {
          source: "markdown",
          sourcePath,
          fileName: path.basename(filePath),
        },
        chunkMetadata: {
          source: "markdown",
          sourcePath,
        },
      });
      console.log(`  ok    ${path.relative(directory, filePath)} (${title})`);
      imported += 1;
    } catch (error) {
      console.error(
        `  fail  ${path.relative(directory, filePath)}: ${
          error instanceof Error ? error.message : error
        }`,
      );
      failed += 1;
    }
  }

  console.log(
    JSON.stringify(
      { directory, total: files.length, imported, skipped, failed },
      null,
      2,
    ),
  );
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
