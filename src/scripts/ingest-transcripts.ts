import "dotenv/config";
import path from "path";
import { db, initializePgVector } from "../db";
import { booksService } from "../services/books";

function defaultTranscriptFile(): string {
  return path.resolve(process.cwd(), "../notebooklm-py/playlist-transcripts.json");
}

function printHelp(): void {
  console.log(`Usage: npm run transcripts:ingest -- [file] [--force]

Imports YouTube transcript JSON into the GLOBAL knowledge base. Every
Declario company chats against this same brain — there is no per-company
scope on books on purpose.

Options:
  file      Optional transcript JSON file (default: ../notebooklm-py/playlist-transcripts.json)
  --force   Re-import transcripts even when metadata.sourcePath already exists
  --help    Show this help text`);
}

function parseArgs(): { filePath: string; force: boolean; help: boolean } {
  const args = process.argv.slice(2);
  const force = args.includes("--force") || process.env.npm_config_force === "true";
  const help = args.includes("--help") || args.includes("-h");
  const fileArg = args.find((arg) => !arg.startsWith("--"));

  return {
    filePath: path.resolve(fileArg ?? defaultTranscriptFile()),
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

  const result = await booksService.ingestTranscriptJsonFile({
    filePath: args.filePath,
    force: args.force,
  });

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
