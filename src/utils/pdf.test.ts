import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import os from "os";
import path from "path";
import { discoverPdfFiles, titleFromPdfPath } from "./pdf";

describe("pdf utilities", () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), "declario-pdfs-"));
  });

  afterEach(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it("discovers PDFs recursively in stable order", async () => {
    await writeFile(path.join(tempDirectory, "b.pdf"), "");
    await writeFile(path.join(tempDirectory, "ignore.txt"), "");
    await mkdir(path.join(tempDirectory, "nested"));
    await writeFile(path.join(tempDirectory, "nested", "a.PDF"), "");

    const files = await discoverPdfFiles(tempDirectory);

    expect(files.map((file) => path.basename(file))).toEqual(["b.pdf", "a.PDF"]);
  });

  it("builds a readable title from a PDF path", () => {
    expect(titleFromPdfPath("/tmp/bug_agricxva.pdf")).toBe("bug agricxva");
  });
});

