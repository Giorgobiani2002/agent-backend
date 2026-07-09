function setEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe("waybill vision", () => {
  const originalEnv = {
    GEMINI_VISION_MODEL: process.env.GEMINI_VISION_MODEL,
    GEMINI_VISION_FALLBACK_MODELS: process.env.GEMINI_VISION_FALLBACK_MODELS,
    GEMINI_VISION_MAX_ATTEMPTS: process.env.GEMINI_VISION_MAX_ATTEMPTS,
    GEMINI_CHAT_MODEL: process.env.GEMINI_CHAT_MODEL,
  };

  afterEach(() => {
    jest.restoreAllMocks();
    jest.dontMock("./vertex");
    jest.resetModules();
    setEnv("GEMINI_VISION_MODEL", originalEnv.GEMINI_VISION_MODEL);
    setEnv("GEMINI_VISION_FALLBACK_MODELS", originalEnv.GEMINI_VISION_FALLBACK_MODELS);
    setEnv("GEMINI_VISION_MAX_ATTEMPTS", originalEnv.GEMINI_VISION_MAX_ATTEMPTS);
    setEnv("GEMINI_CHAT_MODEL", originalEnv.GEMINI_CHAT_MODEL);
  });

  it("falls back to the next vision model when the first one is unavailable", async () => {
    setEnv("GEMINI_VISION_MODEL", "denied-model");
    setEnv("GEMINI_VISION_FALLBACK_MODELS", "working-model");
    setEnv("GEMINI_CHAT_MODEL", "chat-model");

    const generateContent = jest.fn(async ({ model }: { model: string }) => {
      if (model === "denied-model") {
        throw new Error(
          JSON.stringify({
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              message: "Your project has been denied access.",
            },
          }),
        );
      }
      return {
        text: JSON.stringify({
          is_waybill: true,
          confidence: 0.9,
          buyer_tin: "123456789",
          items: [{ w_name: "Goods", unit_txt: "pcs", quantity: 2, price: 5 }],
          warnings: [],
        }),
      };
    });

    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({ models: { generateContent } }),
    }));
    jest.resetModules();

    const { extractWaybillFromImage } = await import("./waybill-vision");
    const result = await extractWaybillFromImage("aW1hZ2U=", "image/png");

    expect(result).toEqual(
      expect.objectContaining({
        is_waybill: true,
        confidence: 0.9,
        buyer_tin: "123456789",
      }),
    );
    expect(generateContent).toHaveBeenCalledTimes(2);
    const calledModels = (
      generateContent.mock.calls as unknown as Array<[{ model: string }]>
    ).map((call) => call[0].model);
    expect(calledModels).toEqual([
      "denied-model",
      "working-model",
    ]);
  });

  it("uses the current chat model for vision by default without legacy fallbacks", async () => {
    delete process.env.GEMINI_VISION_MODEL;
    delete process.env.GEMINI_VISION_FALLBACK_MODELS;
    process.env.GEMINI_CHAT_MODEL = "gemini-3.5-flash";
    jest.resetModules();

    const { waybillVisionModelCandidates } = await import("./waybill-vision");

    expect(waybillVisionModelCandidates()).toEqual(["gemini-3.5-flash"]);
  });

  it("retries the same current model on temporary high-demand errors", async () => {
    setEnv("GEMINI_VISION_MODEL", "current-model");
    setEnv("GEMINI_VISION_FALLBACK_MODELS", "");
    setEnv("GEMINI_VISION_MAX_ATTEMPTS", "4");
    setEnv("GEMINI_CHAT_MODEL", "current-model");

    const generateContent = jest
      .fn()
      .mockRejectedValueOnce(new Error("UNAVAILABLE: high demand"))
      .mockRejectedValueOnce(new Error("503 high demand"))
      .mockResolvedValueOnce({
        text: JSON.stringify({
          is_waybill: true,
          confidence: 0.8,
          buyer_tin: "123456789",
          items: [{ w_name: "Goods", quantity: 1, price: 10 }],
          warnings: [],
        }),
      });

    jest.spyOn(global, "setTimeout").mockImplementation((cb: (_: void) => void) => {
      cb(undefined as void);
      return 0 as unknown as NodeJS.Timeout;
    });
    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({ models: { generateContent } }),
    }));
    jest.resetModules();

    const { extractWaybillFromImage } = await import("./waybill-vision");
    const result = await extractWaybillFromImage("aW1hZ2U=", "image/png");

    expect(result.is_waybill).toBe(true);
    expect(generateContent).toHaveBeenCalledTimes(3);
    const calledModels = (
      generateContent.mock.calls as unknown as Array<[{ model: string }]>
    ).map((call) => call[0].model);
    expect(calledModels).toEqual(["current-model", "current-model", "current-model"]);
  });

  it("parses a JSON object even when the model wraps it in prose", async () => {
    setEnv("GEMINI_VISION_MODEL", "current-model");
    setEnv("GEMINI_VISION_FALLBACK_MODELS", "");
    setEnv("GEMINI_CHAT_MODEL", "current-model");

    const generateContent = jest.fn(async () => ({
      text: [
        "Here is the extraction:",
        JSON.stringify({
          is_waybill: true,
          confidence: 0.88,
          waybill_type: 3,
          buyer_name: "Test Buyer LLC",
          buyer_tin: "123456789",
          items: [{ w_name: "Test Goods", unit_txt: "pcs", quantity: 2, price: 5 }],
          warnings: [],
        }),
      ].join("\n"),
    }));

    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({ models: { generateContent } }),
    }));
    jest.resetModules();

    const { extractWaybillFromImage } = await import("./waybill-vision");
    const result = await extractWaybillFromImage("aW1hZ2U=", "image/png");

    expect(result).toEqual(
      expect.objectContaining({
        is_waybill: true,
        confidence: 0.88,
        waybill_type: 3,
        buyer_name: "Test Buyer LLC",
      }),
    );
    expect(result.items).toHaveLength(1);
  });

  it("returns a 502 error when every configured vision model is unavailable", async () => {
    setEnv("GEMINI_VISION_MODEL", "denied-model");
    setEnv("GEMINI_VISION_FALLBACK_MODELS", "");
    setEnv("GEMINI_CHAT_MODEL", "chat-denied-model");

    const generateContent = jest.fn(async () => {
      throw new Error(
        JSON.stringify({
          error: {
            code: 403,
            status: "PERMISSION_DENIED",
            message: "Your project has been denied access.",
          },
        }),
      );
    });

    jest.doMock("./vertex", () => ({
      getVertexClient: () => ({ models: { generateContent } }),
    }));
    jest.resetModules();

    const { extractWaybillFromImage } = await import("./waybill-vision");
    await expect(extractWaybillFromImage("aW1hZ2U=", "image/png")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("Gemini vision failed for configured model"),
    });
    const calledModels = (
      generateContent.mock.calls as unknown as Array<[{ model: string }]>
    ).map((call) => call[0].model);
    expect(calledModels).toEqual([
      "denied-model",
      "chat-denied-model",
    ]);
  });
});
