import { HttpError } from "../errors";
import {
  assertApprovedKnowledgeMetadata,
  assertSourceIsInForce,
  type CorpusSource,
} from "./corpus-sources";

const source: CorpusSource = {
  id: "test",
  title: "Test",
  rightsStatus: "approved",
  license: "CC BY 4.0",
  attribution: "Test Author",
  sourceUrl: "https://example.com",
  jurisdiction: "GE",
  authorityRank: 50,
  topic: "accounting_book",
  language: "en",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  checksum: null,
  localPaths: ["data/test.md"],
};

describe("corpus source gates", () => {
  it("requires approved rights, license and attribution", () => {
    expect(() =>
      assertApprovedKnowledgeMetadata({
        rightsStatus: "approved",
        license: "CC BY 4.0",
        attribution: "Test Author",
      }),
    ).not.toThrow();
    expect(() =>
      assertApprovedKnowledgeMetadata({
        rightsStatus: "restricted",
        license: "Proprietary",
        attribution: "Unknown",
      }),
    ).toThrow(HttpError);
  });

  it("rejects expired and not-yet-effective sources", () => {
    expect(() => assertSourceIsInForce(source, new Date("2026-06-10T00:00:00Z"))).not.toThrow();
    expect(() =>
      assertSourceIsInForce(
        { ...source, effectiveTo: "2026-01-31" },
        new Date("2026-06-10T00:00:00Z"),
      ),
    ).toThrow(/expired/);
    expect(() =>
      assertSourceIsInForce(
        { ...source, effectiveFrom: "2027-01-01" },
        new Date("2026-06-10T00:00:00Z"),
      ),
    ).toThrow(/not effective/);
  });
});
