import { createHash } from "crypto";
import path from "path";
import { readFile } from "fs/promises";
import { HttpError } from "../errors";
import type { CorpusTopic } from "./corpus-ingest";

export type CorpusRightsStatus = "approved" | "pending" | "restricted";

export interface CorpusSource {
  id: string;
  title: string;
  rightsStatus: CorpusRightsStatus;
  license: string;
  attribution: string;
  sourceUrl: string | null;
  downloadUrl?: string;
  jurisdiction: string;
  authorityRank: number;
  topic: CorpusTopic;
  language: "ka" | "en";
  version?: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  checksum: string | null;
  localPaths?: string[];
  pathPrefix?: string;
}

interface CorpusSourceManifest {
  version: number;
  sources: CorpusSource[];
}

let cachedManifest: CorpusSourceManifest | null = null;

export function defaultCorpusSourceManifestPath(): string {
  return path.resolve(
    process.env.CORPUS_SOURCE_MANIFEST ??
      path.join(process.cwd(), "data", "corpus-sources.json"),
  );
}

function normalizeRelativePath(filePath: string): string {
  return path
    .relative(process.cwd(), path.resolve(filePath))
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function validateSource(source: CorpusSource): void {
  if (!source.id || !source.title || !source.license || !source.attribution) {
    throw new HttpError(500, "Corpus source entries require id, title, license and attribution");
  }
  if (!["approved", "pending", "restricted"].includes(source.rightsStatus)) {
    throw new HttpError(500, `Invalid rightsStatus for corpus source ${source.id}`);
  }
  if (!Number.isFinite(source.authorityRank) || source.authorityRank < 0) {
    throw new HttpError(500, `Invalid authorityRank for corpus source ${source.id}`);
  }
  if (!source.localPaths?.length && !source.pathPrefix) {
    throw new HttpError(500, `Corpus source ${source.id} requires localPaths or pathPrefix`);
  }
}

export async function loadCorpusSourceManifest(
  manifestPath = defaultCorpusSourceManifestPath(),
  force = false,
): Promise<CorpusSourceManifest> {
  if (cachedManifest && !force && manifestPath === defaultCorpusSourceManifestPath()) {
    return cachedManifest;
  }
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as CorpusSourceManifest;
  if (!parsed || !Array.isArray(parsed.sources)) {
    throw new HttpError(500, "Invalid corpus source manifest");
  }
  parsed.sources.forEach(validateSource);
  if (manifestPath === defaultCorpusSourceManifestPath()) {
    cachedManifest = parsed;
  }
  return parsed;
}

export function findCorpusSource(
  filePath: string,
  manifest: CorpusSourceManifest,
): CorpusSource | null {
  const relative = normalizeRelativePath(filePath);
  return (
    manifest.sources.find((source) => source.localPaths?.includes(relative)) ??
    manifest.sources.find(
      (source) => source.pathPrefix && relative.startsWith(source.pathPrefix),
    ) ??
    null
  );
}

export async function sha256File(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

function dateIsAfter(value: string | null, now: Date): boolean {
  return Boolean(value && new Date(`${value}T23:59:59.999Z`).getTime() < now.getTime());
}

function dateIsBefore(value: string | null, now: Date): boolean {
  return Boolean(value && new Date(`${value}T00:00:00.000Z`).getTime() > now.getTime());
}

export function assertSourceIsInForce(source: CorpusSource, now = new Date()): void {
  if (dateIsBefore(source.effectiveFrom, now)) {
    throw new HttpError(409, `Corpus source ${source.id} is not effective yet`);
  }
  if (dateIsAfter(source.effectiveTo, now)) {
    throw new HttpError(409, `Corpus source ${source.id} is expired`);
  }
}

export async function approvedSourceMetadata(
  filePath: string,
  manifest: CorpusSourceManifest,
): Promise<Record<string, unknown>> {
  const source = findCorpusSource(filePath, manifest);
  if (!source) {
    throw new HttpError(
      403,
      `Corpus file is not allowlisted: ${normalizeRelativePath(filePath)}`,
    );
  }
  if (source.rightsStatus !== "approved") {
    throw new HttpError(
      403,
      `Corpus source ${source.id} is ${source.rightsStatus} and cannot enter production RAG`,
    );
  }
  assertSourceIsInForce(source);
  const checksum = await sha256File(filePath);
  if (source.checksum && source.checksum.toLowerCase() !== checksum) {
    throw new HttpError(409, `Checksum mismatch for corpus source ${source.id}`);
  }
  return {
    corpusSourceId: source.id,
    rightsStatus: source.rightsStatus,
    license: source.license,
    attribution: source.attribution,
    sourceUrl: source.sourceUrl,
    jurisdiction: source.jurisdiction,
    authorityRank: source.authorityRank,
    topic: source.topic,
    language: source.language,
    version: source.version,
    effectiveFrom: source.effectiveFrom,
    effectiveTo: source.effectiveTo,
    checksum,
  };
}

export function assertApprovedKnowledgeMetadata(
  metadata: Record<string, unknown>,
): void {
  if (metadata.rightsStatus !== "approved") {
    throw new HttpError(403, "Knowledge requires rightsStatus=approved");
  }
  if (
    typeof metadata.license !== "string" ||
    !metadata.license.trim() ||
    typeof metadata.attribution !== "string" ||
    !metadata.attribution.trim()
  ) {
    throw new HttpError(400, "Approved knowledge requires license and attribution");
  }
}
