describe("geminiService", () => {
  const originalApiKey = process.env.GEMINI_API_KEY;

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock("@google/genai");
    jest.resetModules();

    if (originalApiKey === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = originalApiKey;
    }
  });

  it("returns a controlled error when GEMINI_API_KEY is missing", async () => {
    delete process.env.GEMINI_API_KEY;
    jest.resetModules();

    const { geminiService } = await import("./gemini");

    await expect(geminiService.embed("hello")).rejects.toMatchObject({
      status: 503,
      message: "GEMINI_API_KEY is required to call Gemini",
    });
  });

  it("returns a warning state when validation has no knowledge chunks", async () => {
    const { geminiService } = await import("./gemini");

    const issues = await geminiService.validateData({ amount: "123.45" }, []);

    expect(issues).toEqual([
      expect.objectContaining({
        field: "validation",
        level: "warn",
      }),
    ]);
  });

  it("returns a warning state when validation JSON cannot be parsed", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.GEMINI_API_KEY = "test-key";
    jest.doMock("@google/genai", () => ({
      GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
          generateContent: jest.fn(async () => ({ text: "not json" })),
        },
      })),
    }));
    jest.resetModules();

    const { geminiService } = await import("./gemini");
    const issues = await geminiService.validateData(
      { amount: "123.45" },
      [{ content: "Tax rule", book_title: "VAT Guide" }],
    );

    expect(issues).toEqual([
      expect.objectContaining({
        field: "validation",
        level: "warn",
        reason: expect.stringContaining("invalid JSON"),
      }),
    ]);
  });

  it("returns a warning state when validation upstream fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.GEMINI_API_KEY = "test-key";
    jest.doMock("@google/genai", () => ({
      GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: {
          generateContent: jest.fn(async () => {
            throw new Error("upstream unavailable");
          }),
        },
      })),
    }));
    jest.resetModules();

    const { geminiService } = await import("./gemini");
    const issues = await geminiService.validateData(
      { amount: "123.45" },
      [{ content: "Tax rule", book_title: "VAT Guide" }],
    );

    expect(issues).toEqual([
      expect.objectContaining({
        field: "validation",
        level: "warn",
        reason: expect.stringContaining("upstream unavailable"),
      }),
    ]);
  });
});

