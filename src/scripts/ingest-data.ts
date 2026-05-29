import "dotenv/config";
import path from "path";
import { db, initializePgVector } from "../db";
import { booksService } from "../services/books";

function printHelp(): void {
  console.log(`Usage: npm run db:ingest -- [directory] [--force]

Imports PDF books from backend/data into the GLOBAL accounting/finance
knowledge base. Every Declario company chats against this same brain.

Options:
  directory   Optional PDF folder to scan recursively
  --force     Re-import PDFs even when metadata.sourcePath already exists
  --help      Show this help text`);
}

function parseArgs(): { directory?: string; force: boolean; help: boolean } {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || process.env.npm_config_force === "true";
  const help = args.includes("--help") || args.includes("-h");
  const directoryArg = args.find((arg) => !arg.startsWith("--"));

  return {
    directory: directoryArg ? path.resolve(directoryArg) : undefined,
    force,
    help,
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    return;
  }

  await initializePgVector();

  const result = await booksService.ingestPdfDirectory(args);

  console.log(JSON.stringify(result, null, 2));

  if (result.failed > 0) {
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
