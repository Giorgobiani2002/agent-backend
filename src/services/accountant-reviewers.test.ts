import {
  reviewFilingReadiness,
  reviewReconciliation,
  reviewTaxWorkpaper,
} from "./accountant-reviewers";
import type { GeminiService } from "./gemini";

function fakeGemini(text: string): GeminiService {
  return {
    embed: jest.fn(),
    generateChatResponse: jest.fn(),
    generateWithTools: jest.fn(),
    validateData: jest.fn(),
    generateStructured: jest.fn().mockResolvedValue({ text, model: "fake-model" }),
  } as unknown as GeminiService;
}

const validReview = JSON.stringify({
  summary: "მონაცემები გადასახედად მზადაა.",
  findings: ["Exact match found."],
  risks: [],
  recommended_actions: ["Proceed to human approval."],
  citations: ["payload.exceptions"],
  ready: true,
  confidence: 0.91,
  warnings: [],
});

describe("accountant reviewers", () => {
  it("validates reconciliation, workpaper, and filing readiness outputs", async () => {
    const gemini = fakeGemini(validReview);

    await expect(reviewReconciliation({ matches: [] }, { gemini })).resolves.toMatchObject({
      output: { ready: true, confidence: 0.91 },
    });
    await expect(reviewTaxWorkpaper({ vat: {} }, { gemini })).resolves.toMatchObject({
      output: { ready: true },
    });
    await expect(reviewFilingReadiness({ blockers: [] }, { gemini })).resolves.toMatchObject({
      output: { ready: true },
    });
  });

  it("rejects malformed reviewer output", async () => {
    await expect(
      reviewFilingReadiness({}, { gemini: fakeGemini(JSON.stringify({ summary: "nope" })) }),
    ).rejects.toThrow(/filing_readiness-reviewer-v1/);
  });
});
