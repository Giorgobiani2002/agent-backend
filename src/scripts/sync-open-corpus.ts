import "dotenv/config";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import {
  loadCorpusSourceManifest,
  sha256File,
  type CorpusSource,
} from "../services/corpus-sources";

interface SourceLockEntry {
  sourceId: string;
  localPath: string;
  sourceUrl: string | null;
  downloadUrl: string;
  checksum: string;
  fetchedAt: string;
  bytes: number;
}

const UA = "Declario accounting corpus sync/1.0";

function firstLocalPath(source: CorpusSource): string {
  const localPath = source.localPaths?.[0];
  if (!localPath) throw new Error(`Source ${source.id} has no local path`);
  return path.resolve(process.cwd(), localPath);
}

async function syncSource(source: CorpusSource): Promise<SourceLockEntry> {
  if (!source.downloadUrl) throw new Error(`Source ${source.id} has no downloadUrl`);
  const response = await fetch(source.downloadUrl, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${source.downloadUrl}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const output = firstLocalPath(source);
  const extension = path.extname(output).toLowerCase();
  if (extension === ".pdf" && bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new Error(`Expected PDF but received ${response.headers.get("content-type") ?? "unknown content"}`);
  }
  if (
    extension === ".docx" &&
    !(bytes[0] === 0x50 && bytes[1] === 0x4b)
  ) {
    throw new Error(`Expected DOCX but received ${response.headers.get("content-type") ?? "unknown content"}`);
  }
  if (bytes.length < 10 * 1024) {
    throw new Error(`Downloaded file is unexpectedly small (${bytes.length} bytes)`);
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, bytes);
  const checksum = await sha256File(output);
  if (source.checksum && checksum !== source.checksum.toLowerCase()) {
    throw new Error(`Checksum mismatch for ${source.id}`);
  }
  return {
    sourceId: source.id,
    localPath: path.relative(process.cwd(), output).replace(/\\/g, "/"),
    sourceUrl: source.sourceUrl,
    downloadUrl: source.downloadUrl,
    checksum,
    fetchedAt: new Date().toISOString(),
    bytes: bytes.length,
  };
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const manifest = await loadCorpusSourceManifest();
  const lockPath = path.resolve(process.cwd(), "data", "corpus-source-lock.json");
  const previous = await readFile(lockPath, "utf8")
    .then((value) => JSON.parse(value) as { sources?: SourceLockEntry[] })
    .catch(() => ({ sources: [] as SourceLockEntry[] }));
  const byId = new Map((previous.sources ?? []).map((entry) => [entry.sourceId, entry]));
  const downloadable = manifest.sources.filter(
    (source) => source.rightsStatus === "approved" && source.downloadUrl,
  );

  let failed = 0;
  for (const source of downloadable) {
    const output = firstLocalPath(source);
    const exists = await readFile(output).then(() => true).catch(() => false);
    if (exists && !force) {
      const bytes = await readFile(output);
      const extension = path.extname(output).toLowerCase();
      const valid =
        bytes.length >= 10 * 1024 &&
        (extension === ".pdf"
          ? bytes.subarray(0, 5).toString("ascii") === "%PDF-"
          : extension === ".docx"
            ? bytes[0] === 0x50 && bytes[1] === 0x4b
            : true);
      if (valid) {
        const checksum = await sha256File(output);
        byId.set(source.id, {
          sourceId: source.id,
          localPath: path.relative(process.cwd(), output).replace(/\\/g, "/"),
          sourceUrl: source.sourceUrl,
          downloadUrl: source.downloadUrl!,
          checksum,
          fetchedAt: byId.get(source.id)?.fetchedAt ?? new Date().toISOString(),
          bytes: bytes.length,
        });
        console.log(`skip ${source.id}`);
        continue;
      }
      byId.delete(source.id);
      console.warn(`retry ${source.id}: existing file failed signature validation`);
    }
    try {
      const entry = await syncSource(source);
      byId.set(source.id, entry);
      console.log(`ok   ${source.id} ${Math.round(entry.bytes / 1024)} KB`);
    } catch (error) {
      failed += 1;
      console.error(`fail ${source.id}: ${error instanceof Error ? error.message : error}`);
    }
  }

  await writeFile(
    lockPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt: new Date().toISOString(),
        sources: [...byId.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
