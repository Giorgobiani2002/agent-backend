import { reviewMonthlyClose } from "./monthly-close-reviewer";
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

describe("monthly close reviewer", () => {
  it("returns a validated structured review", async () => {
    const result = await reviewMonthlyClose(
      { period_year: 2026, period_month: 6, exceptions: [] },
      {
        gemini: fakeGemini(
          JSON.stringify({
            summary: "პერიოდი მზადაა გადასახედად.",
            risks: [],
            missing_documents: [],
            recommended_actions: ["გადაამოწმეთ დღგ-ის draft."],
            confidence: 0.94,
            warnings: [],
          }),
        ),
      },
    );

    expect(result.output.confidence).toBe(0.94);
    expect(result.output.recommended_actions).toEqual(["გადაამოწმეთ დღგ-ის draft."]);
    expect(result.model).toBe("fake-model");
  });

  it("rejects malformed model output", async () => {
    await expect(
      reviewMonthlyClose(
        { period_year: 2026, period_month: 6 },
        { gemini: fakeGemini(JSON.stringify({ summary: "missing fields" })) },
      ),
    ).rejects.toThrow(/monthly-close-reviewer-v1/);
  });
});
