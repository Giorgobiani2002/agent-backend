describe("geminiService", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock("./vertex");
    jest.resetModules();
  });

  it("uses the shared Vertex client for embeddings", async () => {
    const embedContent = jest.fn(async () => ({
      embeddings: [{ values: [0.25, 0.75] }],
    }));
    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({ models: { embedContent } }),
      resetVertexClient: jest.fn(),
    }));
    jest.resetModules();

    const { geminiService } = await import("./gemini");

    await expect(geminiService.embed("hello")).resolves.toEqual([0.25, 0.75]);
    expect(embedContent).toHaveBeenCalledWith(
      expect.objectContaining({ contents: "hello" }),
    );
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
    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({
        models: { generateContent: jest.fn(async () => ({ text: "not json" })) },
      }),
      resetVertexClient: jest.fn(),
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
    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({
        models: {
          generateContent: jest.fn(async () => {
            throw new Error("upstream unavailable");
          }),
        },
      }),
      resetVertexClient: jest.fn(),
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

