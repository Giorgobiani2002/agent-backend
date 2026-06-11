import fs from "fs/promises";
import path from "path";
import {
  approvedSourceMetadata,
  assertSourceIsInForce,
  loadCorpusSourceManifest,
} from "../services/corpus-sources";

async function main() {
  const manifest = await loadCorpusSourceManifest(undefined, true);
  let failed = 0;
  let checked = 0;

  for (const source of manifest.sources) {
    if (source.rightsStatus !== "approved") continue;
    try {
      assertSourceIsInForce(source);
    } catch (error) {
      failed += 1;
      console.error(`[expired] ${source.id}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const existingPaths: string[] = [];
    for (const relativePath of source.localPaths ?? []) {
      const filePath = path.resolve(relativePath);
      try {
        await fs.access(filePath);
        existingPaths.push(relativePath);
      } catch {
        // A source may list alternative local formats such as .md and .pdf.
      }
    }
    if ((source.localPaths?.length ?? 0) > 0 && existingPaths.length === 0) {
      failed += 1;
      console.error(
        `[missing] ${source.id}: none of ${source.localPaths!.join(", ")} exists`,
      );
      continue;
    }

    for (const relativePath of existingPaths) {
      const filePath = path.resolve(relativePath);
      try {
        const metadata = await approvedSourceMetadata(filePath, manifest);
        checked += 1;
        console.log(`[ok] ${source.id} ${relativePath} ${String(metadata.checksum).slice(0, 12)}`);
      } catch (error) {
        failed += 1;
        console.error(
          `[invalid] ${source.id} ${relativePath}: ${
            error instanceof Error ? error.message : error
          }`,
        );
      }
    }
  }

  console.log(`Corpus check complete: ${checked} files valid, ${failed} issue(s).`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
