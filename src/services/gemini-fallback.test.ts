function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("gemini service model fallback", () => {
  const originalEnv = {
    GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL,
    GEMINI_CHAT_FALLBACK_MODELS: process.env.GEMINI_CHAT_FALLBACK_MODELS,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock("./vertex");
    jest.resetModules();
    setEnv("GEMINI_CHAT_MODEL", originalEnv.GEMINI_CHAT_MODEL);
    setEnv("GEMINI_CHAT_FALLBACK_MODELS", originalEnv.GEMINI_CHAT_FALLBACK_MODELS);
  });

  it("uses the configured non-legacy fallback model after transient primary failures", async () => {
    setEnv("GEMINI_CHAT_MODEL", "primary-model");
    setEnv("GEMINI_CHAT_FALLBACK_MODELS", "fallback-model");

    const generateContent = jest.fn(async ({ model }: { model: string }) => {
      if (model === "primary-model") {
        throw new Error("503 high demand");
      }
      return { text: "OK", modelVersion: model };
    });

    jest.spyOn(global, "setTimeout").mockImplementation((cb: (_: void) => void) => {
      cb(undefined as void);
      return 0 as unknown as NodeJS.Timeout;
    });
    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({ models: { generateContent } }),
      resetVertexClient: jest.fn(),
    }));
    jest.resetModules();

    const { geminiService } = await import("./gemini");
    const result = await geminiService.generateChatResponse([
      { role: "user", parts: [{ text: "Reply OK" }] },
    ]);

    expect(result).toEqual({ text: "OK", model: "fallback-model" });
    expect(generateContent).toHaveBeenCalledTimes(4);
    const calledModels = (
      generateContent.mock.calls as unknown as Array<[{ model: string }]>
    ).map((call) => call[0].model);
    expect(calledModels).toEqual([
      "primary-model",
      "primary-model",
      "primary-model",
      "fallback-model",
    ]);
  });
});
