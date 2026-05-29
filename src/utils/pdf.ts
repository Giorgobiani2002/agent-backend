import { readdir, readFile, stat } from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";
import { HttpError } from "../errors";

export interface ParsedPdf {
  text: string;
  pages: number;
  info: Record<string, unknown>;
}

export async function parsePdfFile(filePath: string): Promise<ParsedPdf> {
  const data = await readFile(filePath);
  const parser = new PDFParse({ data });

  try {
    const [textResult, infoResult] = await Promise.all([
      parser.getText(),
      parser.getInfo().catch(() => null),
    ]);

    const text = textResult.text.trim();

    if (!text) {
      throw new HttpError(400, `PDF did not contain extractable text: ${filePath}`);
    }

    return {
      text,
      pages: textResult.pages.length,
      info: infoResult?.info ? { ...infoResult.info } : {},
    };
  } finally {
    await parser.destroy();
  }
}

export async function discoverPdfFiles(directory: string): Promise<string[]> {
  const root = path.resolve(directory);
  const rootStat = await stat(root);

  if (!rootStat.isDirectory()) {
    throw new HttpError(400, `PDF data path is not a directory: ${root}`);
  }

  const files: string[] = [];

  async function walk(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDirectory, entry.name);

      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".pdf")) {
        files.push(entryPath);
      }
    }
  }

  await walk(root);

  return files.sort((a, b) => a.localeCompare(b));
}

export function defaultDataDirectory(): string {
  return path.resolve(process.env.BOOK_DATA_DIR ?? path.join(process.cwd(), "data"));
}

export function titleFromPdfPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, " ").trim();
}

