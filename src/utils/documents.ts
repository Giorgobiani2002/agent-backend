import path from "path";
import { readdir, readFile, stat } from "fs/promises";
import mammoth from "mammoth";
import { HttpError } from "../errors";

export interface ParsedDocument {
  text: string;
  warnings: string[];
}

export async function parseDocxFile(filePath: string): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ path: filePath });
  const text = result.value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) {
    throw new HttpError(400, `DOCX did not contain extractable text: ${filePath}`);
  }
  return {
    text,
    warnings: result.messages.map((message) => message.message),
  };
}

export async function discoverDocumentFiles(
  directory: string,
  extensions: string[],
): Promise<string[]> {
  const root = path.resolve(directory);
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const allowed = new Set(extensions.map((extension) => extension.toLowerCase()));
  const files: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase())) {
        files.push(entryPath);
      }
    }
  }
  await walk(root);
  return files.sort();
}

export async function parseTextFile(filePath: string): Promise<ParsedDocument> {
  const text = (await readFile(filePath, "utf8")).trim();
  if (!text) throw new HttpError(400, `Text file is empty: ${filePath}`);
  return { text, warnings: [] };
}
