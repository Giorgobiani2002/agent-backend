import { normalizeExtractedSteps } from "./playbook";

describe("playbook extraction normalization", () => {
  it("normalizes actions, removes duplicates, and marks dangerous final actions", () => {
    const { steps, warnings } = normalizeExtractedSteps([
      { action: "tap", target_description: "Open form", ts_start: 0, ts_end: 1 },
      { action: "click", target_description: "Open form", ts_start: 1, ts_end: 2 },
      { action: "click", target_description: "Submit declaration", target_text: "submit", ts_start: 3, ts_end: 4 },
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: "click", index: 0 });
    expect(steps[1]).toMatchObject({
      dangerous: true,
      danger_reason: expect.any(String),
      evidence: expect.objectContaining({ timestampSeconds: 3.5 }),
    });
    expect(warnings.some((warning) => warning.includes("unsupported action"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("duplicate"))).toBe(true);
  });
});
